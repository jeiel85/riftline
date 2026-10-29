// 방 하나의 권위 시뮬레이션: 이동·사격·스킬·거점·봇·스냅샷.
import { HEROES, HERO_IDS, isHeroId, headCenterY } from '../shared/heroes.js';
import { MAP, spawnZoneTeam, groundHeightAt } from '../shared/map.js';
import { createMoveState, stepMove, forwardVec } from '../shared/physics.js';
import { raycastMap, rayPlayer, raySphere, hasLineOfSight } from '../shared/raycast.js';
import {
  DT, SNAPSHOT_EVERY, MAX_REWIND, MATCH, BTN, TEAM_COUNT, MAX_PLAYERS_PER_ROOM,
  MAX_BOTS_PER_TEAM, ULT_PASSIVE_RATE, NET,
} from '../shared/constants.js';
import { parseCmd, sanitizeChat } from '../shared/protocol.js';
import { BotBrain, BOT_NAMES } from './bot.js';
import { NavGrid } from './nav.js';

let sharedNav = null;
function getNav() {
  if (!sharedNav) sharedNav = new NavGrid(MAP);
  return sharedNav;
}

const PHASES = ['warmup', 'live', 'end'];
const ENT_CODES = { plasma: 'p', orb: 'o', mine: 'm', canister: 'c', meteor: 'M', fire: 'f', sanct: 's', turret: 't' };
const PACK = { small: { heal: 75, respawn: 10 }, large: { heal: 150, respawn: 15 } };
const HISTORY_LEN = 45;

const r2 = (v) => Math.round(v * 100) / 100;
const r4 = (v) => Math.round(v * 10000) / 10000;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

class Player {
  constructor(id, name, team) {
    this.id = id;
    this.name = name;
    this.team = team;
    this.ws = null;
    this.brain = null;
    this.hero = null;
    this.pendingHero = null;
    this.move = createMoveState([0, 0, 0]);
    this.yaw = 0;
    this.pitch = 0;
    this.alive = false;
    this.hp = 0;
    this.respawnT = 0;
    this.spawnSeq = 0;
    this.ammo = 0;
    this.reloadT = 0;
    this.fireT = 0;
    this.cdE = 0;
    this.ult = 0;
    this.status = { fortify: 0, overdrive: 0, slow: 0, recon: 0 };
    this.slam = null;
    this.dashSeqSeen = 0;
    this.dashHits = new Set();
    this.queue = [];
    this.lastSeq = -1;
    this.lastQueuedSeq = -1;
    this.budget = 0;
    this.lastButtons = 0;
    this.rt = 0;
    this.kills = 0;
    this.deaths = 0;
    this.damageDone = 0;
    this.healingDone = 0;
    this.events = [];
    this.chatTokens = NET.chatPerSecond;
    this.lastFireAt = -1;
  }

  get isBot() {
    return this.brain !== null;
  }
}

export class Room {
  constructor(code, { teamSize = 3, rng = Math.random } = {}) {
    this.code = code;
    this.teamSize = clamp(Math.floor(teamSize) || 0, 0, MAX_BOTS_PER_TEAM);
    this.rng = rng;
    this.map = MAP;
    this.nav = getNav();
    this.dt = DT;
    this.players = new Map();
    this.nextId = 1;
    this.time = 0;
    this.tick = 0;
    this.entities = [];
    this.nextEnt = 1;
    this.timers = [];
    this.events = [];
    this.history = [];
    this.phase = 'warmup';
    this.phaseT = MATCH.warmup;
    this.winner = -1;
    this.point = { owner: -1, capTeam: -1, cap: 0, scores: [0, 0], contested: false, counts: [0, 0] };
    this.packs = MAP.healthPacks.map((h) => ({ pos: h.pos, size: h.size, available: true, respawnAt: 0 }));
    this.reconUntil = [0, 0];
    this.rosterDirty = true;
    this.rosterSentAt = -1;
    this.emptySince = 0;
    this.botNameIdx = 0;
  }

  // ── 인원 관리 ───────────────────────────────────
  humans() {
    return [...this.players.values()].filter((p) => !p.isBot);
  }

  teamCounts(filter = () => true) {
    const c = [0, 0];
    for (const p of this.players.values()) if (filter(p)) c[p.team]++;
    return c;
  }

  canJoin() {
    return this.humans().length < MAX_PLAYERS_PER_ROOM;
  }

  addHuman(name) {
    const hc = this.teamCounts((p) => !p.isBot);
    const tc = this.teamCounts();
    let team = hc[0] < hc[1] ? 0 : hc[1] < hc[0] ? 1 : tc[0] <= tc[1] ? 0 : 1;
    const p = new Player(this.nextId++, name, team);
    this.players.set(p.id, p);
    p.respawnT = 0;
    this.balanceBots();
    this.rosterDirty = true;
    this.pushEvent(['info', `${name} 님이 입장했습니다`]);
    return p;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.entities = this.entities.filter((e) => e.owner !== id || e.type === 'fire');
    if (!p.isBot) this.pushEvent(['info', `${p.name} 님이 나갔습니다`]);
    this.balanceBots();
    this.rosterDirty = true;
  }

  // 각 팀 인원을 teamSize 까지 봇으로 채운다(사람이 들어오면 봇이 빠진다).
  balanceBots() {
    for (let t = 0; t < TEAM_COUNT; t++) {
      const humans = [...this.players.values()].filter((p) => p.team === t && !p.isBot).length;
      const bots = [...this.players.values()].filter((p) => p.team === t && p.isBot);
      const want = Math.max(0, this.teamSize - humans);
      while (bots.length > want) {
        const b = bots.pop();
        this.players.delete(b.id);
        this.entities = this.entities.filter((e) => e.owner !== b.id);
      }
      for (let i = bots.length; i < want; i++) {
        if (this.players.size >= MAX_PLAYERS_PER_ROOM) break;
        const name = `봇 ${BOT_NAMES[this.botNameIdx++ % BOT_NAMES.length]}`;
        const b = new Player(this.nextId++, name, t);
        b.brain = new BotBrain(this, b, this.rng);
        this.players.set(b.id, b);
        this.setHero(b, this.pickBotHero(t));
      }
    }
    this.rosterDirty = true;
  }

  pickBotHero(team) {
    const used = new Set([...this.players.values()].filter((p) => p.team === team && p.hero).map((p) => p.hero));
    const free = HERO_IDS.filter((h) => !used.has(h));
    const pool = free.length ? free : HERO_IDS;
    return pool[Math.floor(this.rng() * pool.length)];
  }

  setHero(p, heroId) {
    if (!isHeroId(heroId)) return false;
    const inSpawn = p.alive && spawnZoneTeam(MAP, p.move.x, p.move.y, p.move.z) === p.team;
    if (!p.hero || !p.alive || inSpawn) {
      const wasAlive = p.alive;
      p.hero = heroId;
      p.pendingHero = null;
      p.ult = 0;
      if (wasAlive) this.spawn(p, true);
      else if (p.respawnT <= 0) this.spawn(p);
    } else {
      p.pendingHero = heroId;
      p.events.push(['info', '다음 부활 때 히어로가 변경됩니다']);
    }
    this.rosterDirty = true;
    return true;
  }

  switchTeam(p) {
    const hc = this.teamCounts((q) => !q.isBot);
    const to = 1 - p.team;
    hc[p.team]--;
    hc[to]++;
    if (Math.abs(hc[0] - hc[1]) > 1) {
      p.events.push(['info', '팀 인원 차이 때문에 이동할 수 없습니다']);
      return false;
    }
    p.team = to;
    p.alive = false;
    p.hp = 0;
    p.respawnT = 0.5;
    this.balanceBots();
    this.rosterDirty = true;
    return true;
  }

  // ── 메시지 처리 ────────────────────────────────
  handleMessage(p, msg) {
    switch (msg.t) {
      case 'hero':
        if (isHeroId(msg.hero)) this.setHero(p, msg.hero);
        break;
      case 'team':
        this.switchTeam(p);
        break;
      case 'in': {
        if (!Array.isArray(msg.c) || msg.c.length > NET.maxCmdsPerMessage) return;
        for (const raw of msg.c) {
          const cmd = parseCmd(raw);
          if (!cmd || cmd.seq <= p.lastQueuedSeq) continue;
          p.lastQueuedSeq = cmd.seq;
          p.queue.push(cmd);
        }
        if (p.queue.length > NET.maxQueuedCmds) p.queue.splice(0, p.queue.length - NET.maxQueuedCmds);
        break;
      }
      case 'chat': {
        const text = sanitizeChat(msg.text);
        if (!text || p.chatTokens < 1) return;
        p.chatTokens -= 1;
        this.pushEvent(['chat', p.id, text]);
        break;
      }
      default:
        break;
    }
  }

  pushEvent(ev) {
    this.events.push(ev);
  }

  // ── 스폰·사망 ───────────────────────────────────
  spawn(p, inPlace = false) {
    if (p.pendingHero) {
      p.hero = p.pendingHero;
      p.pendingHero = null;
      p.ult = 0;
    }
    const hero = HEROES[p.hero];
    if (!inPlace) {
      const pts = MAP.spawns[p.team];
      const order = pts.map((s, i) => [i, this.rng()]).sort((a, b) => a[1] - b[1]).map((a) => pts[a[0]]);
      let sp = order[0];
      for (const s of order) {
        let free = true;
        for (const o of this.players.values()) {
          if (o !== p && o.alive && Math.hypot(o.move.x - s.pos[0], o.move.z - s.pos[2]) < 1.3) { free = false; break; }
        }
        if (free) { sp = s; break; }
      }
      p.move = createMoveState(sp.pos);
      p.move.onGround = true;
      p.yaw = sp.yaw;
    } else {
      const keep = p.move;
      p.move = createMoveState([keep.x, keep.y, keep.z]);
      p.move.onGround = keep.onGround;
    }
    p.pitch = 0;
    p.alive = true;
    p.hp = hero.hp;
    p.ammo = hero.weapon.mag;
    p.reloadT = 0;
    p.fireT = 0;
    p.cdE = 0;
    p.status = { fortify: 0, overdrive: 0, slow: 0, recon: 0 };
    p.slam = null;
    p.dashSeqSeen = 0;
    p.spawnSeq++;
    p.queue.length = 0;
    this.rosterDirty = true;
  }

  kill(victim, attacker, cause) {
    if (!victim.alive) return;
    victim.alive = false;
    victim.hp = 0;
    victim.deaths++;
    victim.respawnT = this.phase === 'end' ? 999 : MATCH.respawnTime;
    victim.slam = null;
    victim.status = { fortify: 0, overdrive: 0, slow: 0, recon: 0 };
    if (attacker && attacker !== victim) attacker.kills++;
    this.pushEvent(['kill', attacker ? attacker.id : 0, victim.id, cause || '', attacker ? attacker.team : -1]);
    this.rosterDirty = true;
  }

  // ── 피해·치유 ───────────────────────────────────
  damageMult(attacker) {
    return attacker && attacker.status.recon > 0 ? HEROES.rook.q.damageMult : 1;
  }

  damage(target, amount, attacker, { head = false, cause = '', quiet = false, fromPos = null } = {}) {
    if (!target.alive || amount <= 0) return 0;
    if (attacker && attacker !== target && attacker.team === target.team) return 0;
    let mult = 1;
    if (target.status.fortify > 0) mult *= 1 - HEROES.kodiak.e.reduction;
    if (this.inAllyZone(target, 'sanct')) mult *= 1 - HEROES.sol.q.reduction;
    const dmg = Math.min(target.hp, amount * mult);
    target.hp -= dmg;
    if (attacker && attacker !== target) {
      attacker.damageDone += dmg;
      this.addUlt(attacker, dmg);
      if (!quiet) attacker.events.push(['hit', target.id, Math.round(dmg), head ? 1 : 0, target.hp <= 0 ? 1 : 0]);
    }
    if (!quiet || target.hp <= 0) {
      const from = fromPos || (attacker ? [attacker.move.x, attacker.move.y + 1, attacker.move.z] : null);
      if (from) target.events.push(['dmg', r2(from[0]), r2(from[1]), r2(from[2]), Math.round(dmg)]);
    }
    if (target.hp <= 0.001) this.kill(target, attacker, cause);
    return dmg;
  }

  heal(target, amount, healer, quiet = false) {
    if (!target.alive) return 0;
    const max = HEROES[target.hero].hp;
    const h = Math.min(max - target.hp, amount);
    if (h <= 0) return 0;
    target.hp += h;
    if (healer && healer !== target) {
      healer.healingDone += h;
      this.addUlt(healer, h);
      if (!quiet) healer.events.push(['healed', target.id, Math.round(h)]);
    }
    return h;
  }

  addUlt(p, pts) {
    if (!p.hero || !p.alive) return;
    p.ult = Math.min(HEROES[p.hero].ultCost, p.ult + pts);
  }

  inAllyZone(p, type) {
    for (const e of this.entities) {
      if (e.type !== type || e.team !== p.team) continue;
      if (Math.hypot(p.move.x - e.x, p.move.z - e.z) <= e.r && p.move.y > e.y - 1 && p.move.y < e.y + e.r) return true;
    }
    return false;
  }

  // 반경 피해(거리에 따라 minFrac 까지 감소)
  splash(x, y, z, radius, amount, attacker, team, { exclude = null, minFrac = 0.3, cause = '', knock = 0, slow = 0, slowTime = 0 } = {}) {
    for (const o of this.players.values()) {
      if (!o.alive || o === exclude || o.team === team) continue;
      const h = HEROES[o.hero];
      const cy = clamp(y, o.move.y, o.move.y + h.height);
      const d = Math.hypot(o.move.x - x, cy - y, o.move.z - z);
      if (d > radius) continue;
      if (!hasLineOfSight(MAP, x, y + 0.1, z, o.move.x, cy, o.move.z)) continue;
      const f = 1 - (1 - minFrac) * (d / radius);
      this.damage(o, amount * f, attacker, { cause, fromPos: [x, y, z] });
      if (knock && o.alive) this.knock(o, x, y, z, knock * f, 2);
      if (slow && o.alive) o.status.slow = Math.max(o.status.slow, slowTime);
    }
    for (const e of this.entities) {
      if (e.type !== 'turret' || e.team === team) continue;
      if (Math.hypot(e.x - x, e.y + 0.5 - y, e.z - z) <= radius) this.damageTurret(e, amount * 0.6, attacker);
    }
  }

  knock(p, x, y, z, power, upBias = 0) {
    let dx = p.move.x - x, dy = p.move.y + 1 - y, dz = p.move.z - z;
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l; dy /= l; dz /= l;
    p.move.vx += dx * power;
    p.move.vz += dz * power;
    p.move.vy = Math.max(p.move.vy, 0) + Math.max(0, dy) * power + upBias;
    p.move.onGround = false;
    p.move.dashT = 0;
  }

  // ── 사격 ───────────────────────────────────────
  historyAt(t) {
    const h = this.history;
    if (!h.length) return null;
    if (t >= h[h.length - 1].time) return h[h.length - 1].pos;
    for (let i = h.length - 1; i > 0; i--) {
      const a = h[i - 1], b = h[i];
      if (a.time <= t && t <= b.time) {
        const f = (t - a.time) / (b.time - a.time || 1);
        const out = new Map();
        for (const [id, pa] of a.pos) {
          const pb = b.pos.get(id);
          out.set(id, pb ? [pa[0] + (pb[0] - pa[0]) * f, pa[1] + (pb[1] - pa[1]) * f, pa[2] + (pb[2] - pa[2]) * f] : pa);
        }
        return out;
      }
    }
    return h[0].pos;
  }

  // 지연 보상된 히트스캔. 반환 { t, player?, turret?, head }
  traceShot(shooter, ox, oy, oz, dx, dy, dz, range) {
    const mh = raycastMap(MAP, ox, oy, oz, dx, dy, dz, range);
    let maxT = mh ? mh.t : range;
    let res = { t: maxT, player: null, turret: null, head: false };
    const rewind = shooter.isBot ? 0 : clamp(this.time - shooter.rt, 0, MAX_REWIND);
    const past = rewind > 0 ? this.historyAt(this.time - rewind) : null;
    for (const o of this.players.values()) {
      if (!o.alive || o.team === shooter.team) continue;
      const pos = (past && past.get(o.id)) || [o.move.x, o.move.y, o.move.z];
      const hit = rayPlayer(ox, oy, oz, dx, dy, dz, pos[0], pos[1], pos[2], HEROES[o.hero], res.t);
      if (hit && hit.t < res.t) res = { t: hit.t, player: o, turret: null, head: hit.head };
    }
    for (const e of this.entities) {
      if (e.type !== 'turret' || e.team === shooter.team) continue;
      const t = raySphere(ox, oy, oz, dx, dy, dz, e.x, e.y + 0.55, e.z, 0.55, res.t);
      if (t >= 0 && t < res.t) res = { t, player: null, turret: e, head: false };
    }
    return res;
  }

  spreadDir(f, spread) {
    if (!spread) return f;
    // 원뿔 안 균일 분포
    const a = this.rng() * Math.PI * 2;
    const s = Math.sqrt(this.rng()) * spread;
    let ux = -f[2], uy = 0, uz = f[0];
    const ul = Math.hypot(ux, uz);
    if (ul < 1e-6) { ux = 1; uz = 0; } else { ux /= ul; uz /= ul; }
    const vx = f[1] * uz - f[2] * uy, vy = f[2] * ux - f[0] * uz, vz = f[0] * uy - f[1] * ux;
    const ca = Math.cos(a) * s, sa = Math.sin(a) * s;
    const dx = f[0] + ux * ca + vx * sa, dy = f[1] + uy * ca + vy * sa, dz = f[2] + uz * ca + vz * sa;
    const l = Math.hypot(dx, dy, dz);
    return [dx / l, dy / l, dz / l];
  }

  fireWeapon(p, hero) {
    const w = hero.weapon;
    const m = p.move;
    const eye = [m.x, m.y + hero.eye, m.z];
    const f = forwardVec(p.yaw, p.pitch);
    p.lastFireAt = this.time;
    if (w.type === 'hitscan') {
      const totals = new Map();
      const mult = this.damageMult(p);
      for (let i = 0; i < w.pellets; i++) {
        const d = this.spreadDir(f, w.spread);
        const hit = this.traceShot(p, eye[0], eye[1], eye[2], d[0], d[1], d[2], w.range);
        const ex = eye[0] + d[0] * hit.t, ey = eye[1] + d[1] * hit.t, ez = eye[2] + d[2] * hit.t;
        this.pushEvent(['shot', p.id, r2(ex), r2(ey), r2(ez), hit.player || hit.turret ? 1 : 0]);
        let dmg = w.damage * mult;
        if (w.falloff) {
          const [near, far, minF] = w.falloff;
          if (hit.t > near) dmg *= hit.t >= far ? minF : 1 - (1 - minF) * ((hit.t - near) / (far - near));
        }
        if (hit.player) {
          if (hit.head) dmg *= w.headMult;
          const cur = totals.get(hit.player) || { dmg: 0, head: false };
          cur.dmg += dmg;
          cur.head = cur.head || hit.head;
          totals.set(hit.player, cur);
        } else if (hit.turret) {
          this.damageTurret(hit.turret, dmg, p);
        }
      }
      for (const [target, t] of totals) this.damage(target, t.dmg, p, { head: t.head, cause: p.hero });
    } else {
      this.pushEvent(['fire', p.id]);
      this.spawnProjectile(p, w.projectile, eye, f, w.speed, w.projRadius, w.gravity, w.lifetime);
    }
  }

  spawnProjectile(p, type, eye, dir, speed, radius, gravity, lifetime, extra = {}) {
    // 눈 위치에서 약간 앞에서 생성(자기 몸에 맞지 않게)
    const e = {
      id: this.nextEnt++, type, owner: p.id, team: p.team,
      x: eye[0] + dir[0] * 0.4, y: eye[1] + dir[1] * 0.4 - 0.1, z: eye[2] + dir[2] * 0.4,
      vx: dir[0] * speed, vy: dir[1] * speed, vz: dir[2] * speed,
      r: radius, gravity, until: this.time + lifetime, ...extra,
    };
    // 생성 위치가 벽 안이면 눈 위치에서 시작
    if (raycastMap(MAP, eye[0], eye[1], eye[2], dir[0], dir[1], dir[2], 0.45, radius)) {
      e.x = eye[0]; e.y = eye[1]; e.z = eye[2];
    }
    this.entities.push(e);
    return e;
  }

  // ── 스킬 ───────────────────────────────────────
  useE(p, hero) {
    const a = hero.e;
    const m = p.move;
    const eye = [m.x, m.y + hero.eye, m.z];
    const f = forwardVec(p.yaw, p.pitch);
    switch (a.type) {
      case 'fortify':
        p.status.fortify = a.duration;
        break;
      case 'mine': {
        this.entities = this.entities.filter((e) => !(e.type === 'mine' && e.owner === p.id));
        const d = [f[0], f[1] + 0.15, f[2]];
        const l = Math.hypot(...d);
        this.spawnProjectile(p, 'mine', eye, [d[0] / l, d[1] / l, d[2] / l], a.throwSpeed, 0.2, 20, a.lifetime, { stuck: false, armedAt: Infinity });
        break;
      }
      case 'napalm': {
        const d = [f[0], f[1] + 0.2, f[2]];
        const l = Math.hypot(...d);
        this.spawnProjectile(p, 'canister', eye, [d[0] / l, d[1] / l, d[2] / l], a.throwSpeed, 0.18, 20, 5);
        break;
      }
      case 'turret': {
        const hit = raycastMap(MAP, eye[0], eye[1], eye[2], f[0], f[1], f[2], a.range);
        const t = hit ? Math.max(0, hit.t - 0.6) : a.range;
        const px = eye[0] + f[0] * t, pz = eye[2] + f[2] * t;
        const gy = groundHeightAt(MAP, px, pz, eye[1] + f[1] * t + 0.5, 0.3);
        if (!Number.isFinite(gy)) {
          p.events.push(['info', '설치할 수 없는 위치입니다']);
          return false;
        }
        this.entities = this.entities.filter((e) => !(e.type === 'turret' && e.owner === p.id));
        this.entities.push({
          id: this.nextEnt++, type: 'turret', owner: p.id, team: p.team, x: px, y: gy, z: pz,
          hp: a.hp, until: this.time + a.duration, fireT: 0.5, yaw: p.yaw,
        });
        break;
      }
      case 'pulse':
        for (const o of this.players.values()) {
          if (!o.alive || o.team !== p.team) continue;
          if (Math.hypot(o.move.x - m.x, o.move.y - m.y, o.move.z - m.z) <= a.radius) this.heal(o, a.heal, p);
        }
        this.pushEvent(['pulse', r2(m.x), r2(m.y), r2(m.z), a.radius, p.team]);
        break;
      default:
        return false;
    }
    p.cdE = a.cooldown;
    return true;
  }

  useUlt(p, hero) {
    const a = hero.q;
    const m = p.move;
    const eye = [m.x, m.y + hero.eye, m.z];
    const f = forwardVec(p.yaw, p.pitch);
    switch (a.type) {
      case 'slam': {
        const fl = Math.hypot(f[0], f[2]) || 1;
        m.vy = a.up;
        m.vx = (f[0] / fl) * a.forward;
        m.vz = (f[2] / fl) * a.forward;
        m.onGround = false;
        m.dashT = 0;
        p.slam = { at: this.time, airborne: false };
        break;
      }
      case 'overdrive':
        p.status.overdrive = a.duration;
        break;
      case 'meteor': {
        const hit = raycastMap(MAP, eye[0], eye[1], eye[2], f[0], f[1], f[2], a.range);
        const t = hit ? hit.t : a.range;
        const cx = eye[0] + f[0] * t, cz = eye[2] + f[2] * t;
        const cy = Math.max(0, groundHeightAt(MAP, cx, cz, eye[1] + f[1] * t + 0.5));
        this.pushEvent(['mark', r2(cx), r2(cy), r2(cz), a.area, p.team, a.delay + a.duration]);
        for (let i = 0; i < a.count; i++) {
          const at = this.time + a.delay + (a.duration * i) / a.count;
          this.timers.push({
            at,
            fn: () => {
              if (!this.players.has(p.id)) return;
              const ang = this.rng() * Math.PI * 2, rr = Math.sqrt(this.rng()) * a.area;
              const x = cx + Math.cos(ang) * rr, z = cz + Math.sin(ang) * rr;
              this.entities.push({
                id: this.nextEnt++, type: 'meteor', owner: p.id, team: p.team,
                x: x + 4, y: cy + 26, z, vx: -4 / (26 / 40), vy: -40, vz: 0, r: 0.4, gravity: 0, until: this.time + 3,
              });
            },
          });
        }
        break;
      }
      case 'recon':
        p.status.recon = a.duration;
        this.reconUntil[p.team] = Math.max(this.reconUntil[p.team], this.time + a.duration);
        break;
      case 'sanctuary': {
        const gy = groundHeightAt(MAP, m.x, m.z, m.y + 0.1, 0.3);
        this.entities.push({
          id: this.nextEnt++, type: 'sanct', owner: p.id, team: p.team, x: m.x, y: Number.isFinite(gy) ? gy : m.y, z: m.z,
          r: a.radius, until: this.time + a.duration, tickAt: this.time,
        });
        break;
      }
      default:
        return false;
    }
    p.ult = 0;
    this.pushEvent(['ult', p.id, p.hero, p.team]);
    return true;
  }

  onShift(p, hero) {
    p.dashHits.clear();
    this.pushEvent(['move', p.id, hero.shift.type]);
  }

  // 코디악 돌진 충돌 판정
  ramCheck(p, hero) {
    const sh = hero.shift;
    if (!sh.damage || p.move.dashT <= 0) return;
    const m = p.move;
    for (const o of this.players.values()) {
      if (!o.alive || o.team === p.team || p.dashHits.has(o.id)) continue;
      const oh = HEROES[o.hero];
      if (Math.hypot(o.move.x - m.x, o.move.z - m.z) > hero.radius + oh.radius + 0.35) continue;
      if (o.move.y > m.y + hero.height || o.move.y + oh.height < m.y) continue;
      p.dashHits.add(o.id);
      this.damage(o, sh.damage, p, { cause: 'kodiak-ram' });
      if (o.alive) {
        o.move.vx += m.dashX * sh.knockback;
        o.move.vz += m.dashZ * sh.knockback;
        o.move.vy = Math.max(o.move.vy, 4);
        o.move.onGround = false;
        o.move.dashT = 0;
      }
    }
  }

  slamCheck(p, hero) {
    if (!p.slam) return;
    if (!p.move.onGround) p.slam.airborne = true;
    if (this.time - p.slam.at > 4) { p.slam = null; return; }
    if (p.slam.airborne && p.move.onGround) {
      const a = hero.q;
      const m = p.move;
      p.slam = null;
      this.pushEvent(['boom', r2(m.x), r2(m.y), r2(m.z), a.radius, 'slam']);
      for (const o of this.players.values()) {
        if (!o.alive || o.team === p.team) continue;
        const d = Math.hypot(o.move.x - m.x, o.move.z - m.z);
        if (d > a.radius || Math.abs(o.move.y - m.y) > 3) continue;
        const f = 1 - 0.5 * (d / a.radius);
        this.damage(o, a.damage * f * this.damageMult(p), p, { cause: 'kodiak-slam', fromPos: [m.x, m.y, m.z] });
        if (o.alive) {
          o.move.vy = a.knockup;
          o.move.onGround = false;
          o.move.dashT = 0;
        }
      }
    }
  }

  // ── 명령 처리 ───────────────────────────────────
  moveMods(p) {
    let speedMult = 1;
    if (p.status.overdrive > 0) speedMult *= HEROES.vex.q.speedMult;
    if (p.status.slow > 0) speedMult *= HEROES.vex.e.slow;
    return { speedMult, noShift: false };
  }

  processCmd(p, cmd) {
    p.lastSeq = cmd.seq;
    p.yaw = cmd.yaw;
    p.pitch = cmd.pitch;
    p.rt = cmd.rt;
    if (!p.alive || !p.hero) {
      p.lastButtons = cmd.buttons;
      return;
    }
    const hero = HEROES[p.hero];
    const prevDash = p.move.dashSeq;
    stepMove(p.move, cmd, hero, this.moveMods(p), MAP, DT);
    if (p.move.dashSeq !== prevDash) this.onShift(p, hero);
    this.ramCheck(p, hero);
    this.slamCheck(p, hero);
    if (p.alive) this.combat(p, hero, cmd);
    p.lastButtons = cmd.buttons;
  }

  // 무기·스킬 타이머는 입력 도착과 무관하게 서버 틱마다 흐른다(updatePlayers).
  tickTimers(p, hero) {
    p.fireT = Math.max(0, p.fireT - DT);
    if (p.cdE > 0) p.cdE = Math.max(0, p.cdE - DT);
    if (p.reloadT > 0) {
      p.reloadT -= DT;
      if (p.reloadT <= 1e-9) {
        p.reloadT = 0;
        p.ammo = hero.weapon.mag;
      }
    }
  }

  combat(p, hero, cmd) {
    const w = hero.weapon;
    const b = cmd.buttons;
    const infinite = p.status.overdrive > 0;
    if ((b & BTN.RELOAD) && p.ammo < w.mag && p.reloadT <= 0 && !infinite) p.reloadT = w.reload;
    if ((b & BTN.FIRE) && p.reloadT <= 0 && p.fireT <= 1e-9) {
      if (p.ammo > 0 || infinite) {
        this.fireWeapon(p, hero);
        if (!infinite) p.ammo--;
        p.fireT = w.interval / (infinite ? HEROES.vex.q.fireRateMult : 1);
        if (p.ammo <= 0 && !infinite) p.reloadT = w.reload;
      } else {
        p.reloadT = w.reload;
      }
    }
    if (!p.alive) return;
    if ((b & BTN.E) && p.cdE <= 0) this.useE(p, hero);
    if ((b & BTN.Q) && p.ult >= hero.ultCost) this.useUlt(p, hero);
  }

  // ── 월드 갱신 ───────────────────────────────────
  updateProjectiles() {
    const keep = [];
    for (const e of this.entities) {
      if (this.time > e.until) {
        if (e.type === 'canister') this.onImpact(e, null, e.x, e.y, e.z);
        continue;
      }
      if (!('vx' in e) || e.stuck) {
        keep.push(e);
        continue;
      }
      e.vy -= e.gravity * DT;
      const sp = Math.hypot(e.vx, e.vy, e.vz);
      const dist = sp * DT;
      if (dist < 1e-6) { keep.push(e); continue; }
      const dx = e.vx / sp, dy = e.vy / sp, dz = e.vz / sp;
      const mh = raycastMap(MAP, e.x, e.y, e.z, dx, dy, dz, dist, e.r);
      let bestT = mh ? mh.t : dist;
      let hitPlayer = null;
      let hitTurret = null;
      const hitsPlayers = e.type !== 'mine';
      if (hitsPlayers) {
        for (const o of this.players.values()) {
          if (!o.alive || o.id === e.owner) continue;
          if (o.team === e.team) {
            if (e.type !== 'orb' || o.hp >= HEROES[o.hero].hp) continue; // 솔 구슬은 다친 아군에게만 닿는다
          }
          const h = rayPlayer(e.x, e.y, e.z, dx, dy, dz, o.move.x, o.move.y, o.move.z, HEROES[o.hero], bestT, e.r);
          if (h && h.t < bestT) { bestT = h.t; hitPlayer = o; hitTurret = null; }
        }
        for (const t of this.entities) {
          if (t.type !== 'turret' || t.team === e.team) continue;
          const tt = raySphere(e.x, e.y, e.z, dx, dy, dz, t.x, t.y + 0.55, t.z, 0.55 + e.r, bestT);
          if (tt >= 0 && tt < bestT) { bestT = tt; hitTurret = t; hitPlayer = null; }
        }
      }
      const nx = e.x + dx * bestT, ny = e.y + dy * bestT, nz = e.z + dz * bestT;
      if (hitPlayer || hitTurret || mh && bestT === mh.t) {
        if (e.type === 'mine' && mh) {
          e.x = nx + mh.nx * 0.05; e.y = ny + mh.ny * 0.05; e.z = nz + mh.nz * 0.05;
          e.vx = e.vy = e.vz = 0;
          e.stuck = true;
          e.armedAt = this.time + HEROES.vex.e.armTime;
          keep.push(e);
          continue;
        }
        this.onImpact(e, hitPlayer || hitTurret, nx, ny, nz, mh && !hitPlayer && !hitTurret ? mh : null);
        continue;
      }
      e.x = nx; e.y = ny; e.z = nz;
      keep.push(e);
    }
    this.entities = keep;
  }

  onImpact(e, target, x, y, z, surf = null) {
    const owner = this.players.get(e.owner) || null;
    switch (e.type) {
      case 'plasma': {
        const w = HEROES.ember.weapon;
        const mult = this.damageMult(owner);
        if (target && target.move) this.damage(target, w.damage * mult, owner, { cause: 'ember' });
        else if (target) this.damageTurret(target, w.damage, owner);
        this.splash(x, y, z, w.splashRadius, w.splash * mult, owner, e.team, { exclude: target && target.move ? target : null, cause: 'ember', knock: 3 });
        // 로켓 점프: 자신은 피해 없이 밀려난다
        if (owner && owner.alive && owner.hero === 'ember') {
          const d = Math.hypot(owner.move.x - x, owner.move.y + 0.9 - y, owner.move.z - z);
          if (d < w.splashRadius) this.knock(owner, x, y - 0.3, z, w.selfKnockback * (1 - 0.5 * d / w.splashRadius), 1);
        }
        this.pushEvent(['boom', r2(x), r2(y), r2(z), w.splashRadius, 'plasma']);
        break;
      }
      case 'orb': {
        const w = HEROES.sol.weapon;
        if (target && target.move) {
          if (target.team === e.team) this.heal(target, w.heal, owner);
          else this.damage(target, w.damage * this.damageMult(owner), owner, { cause: 'sol' });
        } else if (target) {
          this.damageTurret(target, w.damage, owner);
        }
        this.pushEvent(['puff', r2(x), r2(y), r2(z), target && target.team === e.team ? 1 : 0]);
        break;
      }
      case 'meteor': {
        const a = HEROES.ember.q;
        this.splash(x, y, z, a.splashRadius, a.damage * this.damageMult(owner), owner, e.team, { cause: 'ember-meteor', minFrac: 0.5, knock: 4 });
        if (target && target.type === 'turret') this.damageTurret(target, a.damage, owner);
        this.pushEvent(['boom', r2(x), r2(y), r2(z), a.splashRadius, 'meteor']);
        break;
      }
      case 'canister': {
        const a = HEROES.ember.e;
        const gy = groundHeightAt(MAP, x, z, y + 0.5, 0);
        this.entities.push({
          id: this.nextEnt++, type: 'fire', owner: e.owner, team: e.team,
          x, y: Number.isFinite(gy) ? gy : y, z, r: a.radius, until: this.time + a.duration, tickAt: this.time,
        });
        this.pushEvent(['boom', r2(x), r2(y), r2(z), 1.5, 'canister']);
        break;
      }
      default:
        break;
    }
    void surf;
  }

  damageTurret(t, amount, attacker) {
    t.hp -= amount;
    if (attacker) attacker.events.push(['hit', -t.id, Math.round(amount), 0, t.hp <= 0 ? 1 : 0]);
  }

  updateEntities() {
    const keep = [];
    for (const e of this.entities) {
      if (this.time > e.until && e.type !== 'canister') {
        if (e.type === 'turret') this.pushEvent(['boom', r2(e.x), r2(e.y + 0.5), r2(e.z), 1, 'turret']);
        continue;
      }
      if (e.type === 'mine' && e.stuck && this.time >= e.armedAt) {
        const a = HEROES.vex.e;
        let trig = false;
        for (const o of this.players.values()) {
          if (!o.alive || o.team === e.team) continue;
          const d = Math.hypot(o.move.x - e.x, o.move.y + 0.9 - e.y, o.move.z - e.z);
          if (d <= a.triggerRadius && hasLineOfSight(MAP, e.x, e.y + 0.1, e.z, o.move.x, o.move.y + 0.9, o.move.z)) { trig = true; break; }
        }
        if (trig) {
          const owner = this.players.get(e.owner) || null;
          this.splash(e.x, e.y, e.z, a.blastRadius, a.damage * this.damageMult(owner), owner, e.team,
            { cause: 'vex-mine', minFrac: 0.6, slow: a.slow, slowTime: a.slowTime });
          this.pushEvent(['boom', r2(e.x), r2(e.y), r2(e.z), a.blastRadius, 'mine']);
          continue;
        }
      }
      if (e.type === 'fire' || e.type === 'sanct') {
        if (this.time >= e.tickAt) {
          e.tickAt += 0.25;
          const owner = this.players.get(e.owner) || null;
          for (const o of this.players.values()) {
            if (!o.alive) continue;
            if (Math.hypot(o.move.x - e.x, o.move.z - e.z) > e.r || o.move.y < e.y - 1 || o.move.y > e.y + (e.type === 'fire' ? 2.5 : e.r)) continue;
            if (e.type === 'fire' && o.team !== e.team) {
              this.damage(o, HEROES.ember.e.dps * 0.25 * this.damageMult(owner), owner, { cause: 'ember-napalm', quiet: true, fromPos: [e.x, e.y, e.z] });
            } else if (e.type === 'sanct' && o.team === e.team) {
              this.heal(o, HEROES.sol.q.hps * 0.25, owner, true);
            }
          }
        }
      }
      if (e.type === 'turret') {
        if (e.hp <= 0) {
          this.pushEvent(['boom', r2(e.x), r2(e.y + 0.5), r2(e.z), 1.2, 'turret']);
          continue;
        }
        e.fireT -= DT;
        if (e.fireT <= 0) {
          const a = HEROES.rook.e;
          const mx = e.x, my = e.y + 0.75, mz = e.z;
          let best = null, bd = a.fireRange;
          for (const o of this.players.values()) {
            if (!o.alive || o.team === e.team) continue;
            const h = HEROES[o.hero];
            const ty = o.move.y + h.height * 0.6;
            const d = Math.hypot(o.move.x - mx, ty - my, o.move.z - mz);
            if (d < bd && hasLineOfSight(MAP, mx, my, mz, o.move.x, ty, o.move.z)) { bd = d; best = o; }
          }
          if (best) {
            const owner = this.players.get(e.owner) || null;
            const h = HEROES[best.hero];
            e.yaw = Math.atan2(-(best.move.x - mx), -(best.move.z - mz));
            this.pushEvent(['shot', -e.id, r2(best.move.x), r2(best.move.y + h.height * 0.6), r2(best.move.z), 1]);
            this.damage(best, a.damage, owner, { cause: 'rook-turret', quiet: true, fromPos: [mx, my, mz] });
            e.fireT = a.interval;
          } else {
            e.fireT = 0.2;
          }
        }
      }
      keep.push(e);
    }
    this.entities = keep;
  }

  updatePlayers() {
    for (const p of this.players.values()) {
      p.chatTokens = Math.min(NET.chatPerSecond * 2, p.chatTokens + NET.chatPerSecond * DT);
      if (!p.hero) continue;
      if (!p.alive) {
        if (p.respawnT > 0) p.respawnT -= DT;
        if (p.respawnT <= 0 && this.phase !== 'end') this.spawn(p);
        continue;
      }
      const s = p.status;
      for (const k of ['fortify', 'overdrive', 'slow', 'recon']) if (s[k] > 0) s[k] = Math.max(0, s[k] - DT);
      const hero = HEROES[p.hero];
      this.tickTimers(p, hero);
      this.addUlt(p, ULT_PASSIVE_RATE * DT);
      if (spawnZoneTeam(MAP, p.move.x, p.move.y, p.move.z) === p.team) this.heal(p, MATCH.spawnHealRate * DT, null, true);
      if (p.move.y < -15) this.kill(p, null, 'fall');
      // 회복 팩
      for (const pk of this.packs) {
        if (!pk.available || p.hp >= hero.hp) continue;
        if (Math.hypot(pk.pos[0] - p.move.x, pk.pos[2] - p.move.z) < 1.1 && Math.abs(pk.pos[1] - p.move.y) < 1.5) {
          this.heal(p, PACK[pk.size].heal, null, true);
          pk.available = false;
          pk.respawnAt = this.time + PACK[pk.size].respawn;
          p.events.push(['pack', PACK[pk.size].heal]);
        }
      }
    }
    for (const pk of this.packs) if (!pk.available && this.time >= pk.respawnAt) pk.available = true;
  }

  updateObjective() {
    const pt = this.point;
    if (this.phase === 'warmup') {
      this.phaseT -= DT;
      if (this.phaseT <= 0) this.startLive();
      return;
    }
    if (this.phase === 'end') {
      this.phaseT -= DT;
      if (this.phaseT <= 0) this.resetMatch();
      return;
    }
    const P = MAP.point;
    pt.counts = [0, 0];
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const dy = p.move.y - P.pos[1];
      if (dy > -0.6 && dy < 4 && Math.hypot(p.move.x - P.pos[0], p.move.z - P.pos[2]) <= P.radius) pt.counts[p.team]++;
    }
    const [a, b] = pt.counts;
    pt.contested = a > 0 && b > 0;
    if (!pt.contested && (a > 0 || b > 0)) {
      const team = a > 0 ? 0 : 1;
      const n = a + b;
      if (team !== pt.owner) {
        const rate = (DT / MATCH.captureTime) * Math.min(2, 1 + 0.5 * (n - 1));
        if (pt.capTeam !== team && pt.cap > 0) {
          pt.cap = Math.max(0, pt.cap - rate);
          if (pt.cap === 0) pt.capTeam = -1;
        } else {
          pt.capTeam = team;
          pt.cap += rate;
          if (pt.cap >= 1) {
            pt.owner = team;
            pt.cap = 0;
            pt.capTeam = -1;
            this.pushEvent(['cap', team]);
          }
        }
      } else if (pt.cap > 0) {
        pt.cap = Math.max(0, pt.cap - DT / MATCH.captureTime);
        if (pt.cap === 0) pt.capTeam = -1;
      }
    } else if (!pt.contested && pt.cap > 0) {
      pt.cap = Math.max(0, pt.cap - (DT / MATCH.captureTime) * 0.5);
      if (pt.cap === 0) pt.capTeam = -1;
    }
    if (pt.owner >= 0) {
      const enemyOn = pt.counts[1 - pt.owner] > 0;
      let s = pt.scores[pt.owner] + MATCH.scoreRate * DT;
      // 추가 시간: 적이 거점 위에 있으면 99%에서 멈춘다
      if (s >= MATCH.winScore && enemyOn) s = MATCH.winScore - 0.01;
      pt.scores[pt.owner] = Math.min(MATCH.winScore, s);
      if (pt.scores[pt.owner] >= MATCH.winScore) this.endMatch(pt.owner);
    }
  }

  startLive() {
    this.phase = 'live';
    this.phaseT = 0;
    this.point = { owner: -1, capTeam: -1, cap: 0, scores: [0, 0], contested: false, counts: [0, 0] };
    this.entities = [];
    this.timers = [];
    for (const p of this.players.values()) {
      if (!p.hero) continue;
      p.ult = 0;
      this.spawn(p);
    }
    this.pushEvent(['phase', 'live', -1]);
  }

  endMatch(winner) {
    this.phase = 'end';
    this.phaseT = MATCH.endDuration;
    this.winner = winner;
    this.pushEvent(['phase', 'end', winner]);
  }

  resetMatch() {
    this.phase = 'warmup';
    this.phaseT = MATCH.warmup;
    this.winner = -1;
    this.point = { owner: -1, capTeam: -1, cap: 0, scores: [0, 0], contested: false, counts: [0, 0] };
    this.entities = [];
    this.timers = [];
    for (const p of this.players.values()) {
      p.kills = 0; p.deaths = 0; p.damageDone = 0; p.healingDone = 0;
      if (p.hero) { p.ult = 0; this.spawn(p); }
    }
    this.packs.forEach((pk) => { pk.available = true; });
    this.rosterDirty = true;
    this.pushEvent(['phase', 'warmup', -1]);
  }

  // ── 틱 ─────────────────────────────────────────
  update() {
    this.time += DT;
    this.tick++;

    for (const p of this.players.values()) {
      if (p.isBot) {
        this.processCmd(p, p.brain.think());
        continue;
      }
      p.budget = Math.min(0.3, p.budget + DT);
      while (p.queue.length && p.budget >= DT - 1e-9) {
        p.budget -= DT;
        this.processCmd(p, p.queue.shift());
      }
    }

    if (this.timers.length) {
      const due = this.timers.filter((t) => t.at <= this.time);
      if (due.length) {
        this.timers = this.timers.filter((t) => t.at > this.time);
        for (const t of due) t.fn();
      }
    }
    this.updateProjectiles();
    this.updateEntities();
    this.updatePlayers();
    this.updateObjective();

    const pos = new Map();
    for (const p of this.players.values()) if (p.alive) pos.set(p.id, [p.move.x, p.move.y, p.move.z]);
    this.history.push({ time: this.time, pos });
    if (this.history.length > HISTORY_LEN) this.history.shift();

    if (this.tick % SNAPSHOT_EVERY === 0) this.broadcast();
  }

  // ── 송신 ───────────────────────────────────────
  rosterMessage() {
    return {
      t: 'roster',
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, team: p.team, hero: p.hero, k: p.kills, d: p.deaths,
        dmg: Math.round(p.damageDone), heal: Math.round(p.healingDone), bot: p.isBot ? 1 : 0,
      })),
    };
  }

  buildSnapshot(p) {
    const revealTeam = this.reconUntil[p.team] > this.time;
    const pl = [];
    for (const o of this.players.values()) {
      if (!o.hero || o === p) continue;
      let flags = 0;
      if (o.alive) flags |= 1;
      if (o.status.fortify > 0) flags |= 2;
      if (o.status.overdrive > 0) flags |= 4;
      if (o.status.slow > 0) flags |= 8;
      if (revealTeam && o.team !== p.team) flags |= 16;
      if (o.move.dashT > 0) flags |= 32;
      if (o.reloadT > 0) flags |= 64;
      if (this.time - o.lastFireAt < 0.15) flags |= 128;
      pl.push([o.id, r2(o.move.x), r2(o.move.y), r2(o.move.z), r2(o.yaw), r2(o.pitch), Math.ceil(o.hp), flags, HERO_IDS.indexOf(o.hero), o.team]);
    }
    const en = this.entities.map((e) => {
      let extra = 0;
      if (e.type === 'fire' || e.type === 'sanct') extra = e.r;
      else if (e.type === 'turret') extra = r2(e.yaw);
      else if (e.type === 'mine') extra = this.time >= e.armedAt ? 1 : 0;
      return [e.id, ENT_CODES[e.type], r2(e.x), r2(e.y), r2(e.z), e.team, extra];
    });
    const pt = this.point;
    const m = p.move;
    const hero = p.hero ? HEROES[p.hero] : null;
    let packs = 0;
    this.packs.forEach((pk, i) => { if (pk.available) packs |= 1 << i; });
    return {
      t: 's',
      tm: r4(this.time),
      ack: p.lastSeq,
      me: {
        x: r4(m.x), y: r4(m.y), z: r4(m.z), vx: r4(m.vx), vy: r4(m.vy), vz: r4(m.vz),
        og: m.onGround ? 1 : 0, dt: r4(m.dashT), dx: r4(m.dashX), dz: r4(m.dashZ), dsq: m.dashSeq, cs: r4(m.cdShift),
        hero: p.hero, team: p.team, alive: p.alive ? 1 : 0, hp: Math.ceil(p.hp), rsp: r2(Math.max(0, p.respawnT)),
        ammo: p.ammo, rl: r2(p.reloadT), ce: r2(p.cdE), ult: hero ? Math.floor((p.ult / hero.ultCost) * 100) : 0,
        sp: p.spawnSeq, yaw: r4(p.yaw),
        st: [r2(p.status.fortify), r2(p.status.overdrive), r2(p.status.slow), r2(p.status.recon)],
        ph: p.pendingHero,
      },
      pl,
      en,
      ob: [PHASES.indexOf(this.phase), r2(this.phaseT), pt.owner, pt.capTeam, r4(pt.cap), r2(pt.scores[0]), r2(pt.scores[1]),
        pt.contested ? 1 : 0, pt.counts[0], pt.counts[1], this.winner],
      pk: packs,
      ev: this.events.concat(p.events),
    };
  }

  broadcast() {
    const sendRoster = this.rosterDirty && this.time - this.rosterSentAt > 0.25;
    const roster = sendRoster ? JSON.stringify(this.rosterMessage()) : null;
    if (sendRoster) {
      this.rosterDirty = false;
      this.rosterSentAt = this.time;
    }
    for (const p of this.players.values()) {
      if (p.isBot) continue;
      if (p.ws && p.ws.readyState === 1) {
        if (roster) p.ws.send(roster);
        p.ws.send(JSON.stringify(this.buildSnapshot(p)));
      }
      p.events.length = 0;
    }
    for (const p of this.players.values()) if (p.isBot) p.events.length = 0;
    this.events.length = 0;
  }
}
