// 게임 진행: 고정 스텝 입력·이동 예측, 서버 보정, 원격 보간, 렌더링, 이벤트 처리.
import * as THREE from 'three';
import { DT, INTERP_DELAY, BTN, TEAM_COLORS } from './shared/constants.js';
import { HEROES, HERO_IDS, headCenterY } from './shared/heroes.js';
import { MAP } from './shared/map.js';
import { createMoveState, stepMove, forwardVec } from './shared/physics.js';
import { raycastMap, rayPlayer } from './shared/raycast.js';
import { World } from './world.js';
import { Effects } from './effects.js';
import { HeroModel, buildViewmodel } from './characters.js';
import { Hud } from './hud.js';

const SHOT_SOUND = { kodiak: 'shotgun', vex: 'rifle', ember: 'plasma', rook: 'rail', sol: 'orb' };
const TRACER = { kodiak: [0xffd38a, 0.8], vex: [0x7ff6ee, 1], rook: [0xc6ff6a, 2.4] };
const BOOM_COLOR = { plasma: 0xff8a2a, mine: 0x46f0e0, slam: 0xe8a050, meteor: 0xff5a14, canister: 0xff7a1a, turret: 0xc6ff6a };
// 히어로별 1인칭 무기 위치(카메라 공간)와 크기
const VM = {
  kodiak: { pos: [0.3, -0.32, -0.62], scale: 0.8 },
  vex: { pos: [0.2, -0.22, -0.5], scale: 1 },
  ember: { pos: [0.32, -0.3, -0.62], scale: 0.62 },
  rook: { pos: [0.2, -0.22, -0.48], scale: 1 },
  sol: { pos: [0.24, -0.22, -0.45], scale: 1 },
};

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();

function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

const r4 = (v) => Math.round(v * 10000) / 10000;

export class Game {
  constructor({ net, input, sfx, container, settings, callbacks }) {
    this.net = net;
    this.input = input;
    this.sfx = sfx;
    this.container = container;
    this.settings = settings;
    this.cb = callbacks;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.autoClear = false;
    container.appendChild(this.renderer.domElement);
    input.target = this.renderer.domElement;

    this.world = new World();
    this.scene = this.world.scene;
    this.camera = new THREE.PerspectiveCamera(settings.fov, 1, 0.05, 600);
    this.camera.rotation.order = 'YXZ';
    this.effects = new Effects(this.scene);
    this.hud = new Hud();

    // 1인칭 무기는 별도 씬에 그려 벽을 뚫고 보이지 않게 한다
    this.vmScene = new THREE.Scene();
    this.vmCamera = new THREE.PerspectiveCamera(68, 1, 0.01, 10);
    this.vmScene.add(new THREE.HemisphereLight('#dfe9ff', '#4a4038', 1.6));
    const vmSun = new THREE.DirectionalLight('#fff1dc', 2.2);
    vmSun.position.set(1, 2, 1);
    this.vmScene.add(vmSun);
    this.viewmodel = null;
    this.vmHero = null;

    this.myId = 0;
    this.myTeam = 0;
    this.roster = new Map();
    this.me = null;
    this.ob = [0, 0, -1, -1, 0, 0, 0, 0, 0, 0, -1];
    this.pred = createMoveState([0, 0, 0]);
    this.prev = new THREE.Vector3();
    this.correction = new THREE.Vector3();
    this.predReady = false;
    this.pending = [];
    this.outbox = [];
    this.seq = 0;
    this.lastSpawnSeq = -1;
    this.snaps = [];
    this.models = new Map();
    this.acc = 0;
    this.lastFrame = 0;
    this.renderTime = 0;
    this.fireCd = 0;
    this.lastButtons = 0;
    this.recoil = 0;
    this.bobT = 0;
    this.stepT = 0;
    this.shake = 0;
    this.deathPos = null;
    this.scoreboardOn = false;
    this.chatOpen = false;
    this.zoom = 0;
    this.running = false;
    this.renderPos = new THREE.Vector3();

    this.onResize = () => this.resize();
    window.addEventListener('resize', this.onResize);
    this.resize();

    net.on('roster', (m) => {
      this.roster = new Map(m.players.map((p) => [p.id, p]));
      if (this.scoreboardOn) this.hud.scoreboard(true, [...this.roster.values()], this.myId);
      const mine = this.roster.get(this.myId);
      if (mine) this.myTeam = mine.team;
    });
    net.on('s', (s) => this.onSnapshot(s));
  }

  start(welcome) {
    this.myId = welcome.id;
    this.myTeam = welcome.team;
    this.running = true;
    this.hud.show(true);
    this.lastFrame = performance.now();
    const loop = (t) => {
      if (!this.running) return;
      this.frame(t);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    this.hud.show(false);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.vmCamera.aspect = w / h;
    this.vmCamera.updateProjectionMatrix();
  }

  get myHero() {
    return this.me && this.me.hero ? HEROES[this.me.hero] : null;
  }

  moveMods() {
    const st = this.me ? this.me.st : [0, 0, 0, 0];
    let speedMult = 1;
    if (st[1] > 0) speedMult *= HEROES.vex.q.speedMult;
    if (st[2] > 0) speedMult *= HEROES.vex.e.slow;
    return { speedMult, noShift: false };
  }

  // ── 고정 스텝 ───────────────────────────────────
  step() {
    const [mx, mz] = this.input.axes();
    const buttons = this.input.buttons();
    const cmd = { seq: this.seq++, mx, mz, yaw: this.input.yaw, pitch: this.input.pitch, buttons, rt: this.renderTime };
    const hero = this.myHero;
    if (this.predReady && this.me && this.me.alive && hero) {
      this.prev.set(this.pred.x, this.pred.y, this.pred.z);
      const dashBefore = this.pred.dashSeq;
      const wasGround = this.pred.onGround;
      stepMove(this.pred, cmd, hero, this.moveMods(), MAP, DT);
      if (this.pred.dashSeq !== dashBefore) {
        this.sfx.play(hero.shift.type === 'dash' ? 'dash' : 'jump');
        this.fovKick = 1;
      }
      if (wasGround && !this.pred.onGround && this.pred.vy > 5 && (buttons & BTN.JUMP)) this.sfx.play('step');
      this.localWeapon(cmd, hero);
      this.pending.push(cmd);
    }
    this.lastButtons = buttons;
    this.outbox.push([cmd.seq, mx, mz, r4(cmd.yaw), r4(cmd.pitch), buttons, Math.round(cmd.rt * 1000) / 1000]);
  }

  // 자기 사격 연출(판정은 서버). 총구 섬광·반동·소리·탄도선을 즉시 보여 준다.
  localWeapon(cmd, hero) {
    const me = this.me;
    const w = hero.weapon;
    this.fireCd = Math.max(0, this.fireCd - DT);
    const overdrive = me.st[1] > 0;
    const pressed = cmd.buttons & ~this.lastButtons;
    if ((cmd.buttons & BTN.FIRE) && this.fireCd <= 0 && me.rl <= 0) {
      if (me.ammo > 0 || overdrive) {
        this.fireCd = w.interval / (overdrive ? HEROES.vex.q.fireRateMult : 1);
        this.fireFx(hero, cmd);
      } else if (pressed & BTN.FIRE) {
        this.sfx.play('empty');
      }
    }
    if ((pressed & BTN.RELOAD) && me.ammo < w.mag && me.rl <= 0) this.sfx.play('reload');
    if ((pressed & BTN.E) && me.ce > 0) this.sfx.play('deny');
    if ((pressed & BTN.Q) && me.ult < 100) this.sfx.play('deny');
  }

  fireFx(hero, cmd) {
    const w = hero.weapon;
    this.recoil = 1;
    this.sfx.play(SHOT_SOUND[hero.id]);
    const eye = tmpV.set(this.pred.x, this.pred.y + hero.eye, this.pred.z);
    const f = forwardVec(cmd.yaw, cmd.pitch);
    const muzzle = this.vmMuzzleWorld(tmpV2);
    this.effects.muzzle(muzzle, hero.id === 'sol' ? 0xffe36b : hero.id === 'ember' ? 0xff9a2e : 0xffd27a);
    if (w.type !== 'hitscan') return;
    const [color, width] = TRACER[hero.id];
    for (let i = 0; i < w.pellets; i++) {
      let d = f;
      if (w.spread) {
        const a = Math.random() * Math.PI * 2, s = Math.sqrt(Math.random()) * w.spread;
        const right = [Math.cos(cmd.yaw), 0, -Math.sin(cmd.yaw)];
        const up = [Math.sin(cmd.yaw) * Math.sin(cmd.pitch), Math.cos(cmd.pitch), Math.cos(cmd.yaw) * Math.sin(cmd.pitch)];
        d = [f[0] + (right[0] * Math.cos(a) + up[0] * Math.sin(a)) * s, f[1] + up[1] * Math.sin(a) * s, f[2] + (right[2] * Math.cos(a) + up[2] * Math.sin(a)) * s];
        const l = Math.hypot(...d);
        d = [d[0] / l, d[1] / l, d[2] / l];
      }
      const t = this.traceCosmetic(eye, d, w.range);
      const end = new THREE.Vector3(eye.x + d[0] * t, eye.y + d[1] * t, eye.z + d[2] * t);
      this.effects.tracer(muzzle.clone(), end, color, width);
    }
  }

  traceCosmetic(eye, d, range) {
    const mh = raycastMap(MAP, eye.x, eye.y, eye.z, d[0], d[1], d[2], range);
    let t = mh ? mh.t : range;
    for (const [id, m] of this.models) {
      if (id === this.myId || !m.alive || m.team === this.myTeam) continue;
      const p = m.group.position;
      const hit = rayPlayer(eye.x, eye.y, eye.z, d[0], d[1], d[2], p.x, p.y, p.z, m.hero, t);
      if (hit) t = hit.t;
    }
    return t;
  }

  vmMuzzleWorld(out) {
    // 1인칭 무기 씬은 카메라 공간과 같으므로 총구 위치를 메인 카메라 변환으로 월드에 옮긴다
    const cam = this.camera;
    const muzzle = this.viewmodel && this.viewmodel.getObjectByName('muzzle');
    if (muzzle) {
      this.viewmodel.updateMatrixWorld(true);
      muzzle.getWorldPosition(out);
    } else {
      out.set(0.18, -0.16, -0.7);
    }
    out.applyQuaternion(cam.quaternion).add(cam.position);
    return out;
  }

  flushInput() {
    while (this.outbox.length) {
      const c = this.outbox.splice(0, 16);
      this.net.send({ t: 'in', c });
    }
  }

  // ── 스냅샷 ─────────────────────────────────────
  onSnapshot(s) {
    this.snaps.push({ tm: s.tm, pl: new Map(s.pl.map((a) => [a[0], a])), en: new Map(s.en.map((a) => [a[0], a])) });
    if (this.snaps.length > 40) this.snaps.shift();
    const prevMe = this.me;
    const me = s.me;
    this.me = me;
    this.myTeam = me.team;
    this.ob = s.ob;

    if (me.hero && (!prevMe || prevMe.hero !== me.hero || !this.viewmodel)) this.setViewmodel(me.hero);

    this.pending = this.pending.filter((c) => c.seq > s.ack);
    const hero = me.hero ? HEROES[me.hero] : null;
    if (me.sp !== this.lastSpawnSeq) {
      this.lastSpawnSeq = me.sp;
      this.loadServerState(me);
      this.prev.set(me.x, me.y, me.z);
      this.correction.set(0, 0, 0);
      this.pending.length = 0;
      this.input.yaw = me.yaw;
      this.input.pitch = 0;
      this.predReady = true;
      this.deathPos = null;
      this.fireCd = 0;
    } else if (me.alive && hero && this.predReady) {
      const bx = this.pred.x, by = this.pred.y, bz = this.pred.z;
      this.loadServerState(me);
      const mods = this.moveMods();
      for (const c of this.pending) stepMove(this.pred, c, hero, mods, MAP, DT);
      const ex = bx - this.pred.x, ey = by - this.pred.y, ez = bz - this.pred.z;
      if (Math.hypot(ex, ey, ez) > 3) {
        this.correction.set(0, 0, 0);
        this.prev.set(this.pred.x, this.pred.y, this.pred.z);
      } else {
        // 보정량을 화면에서 서서히 흡수
        this.correction.x += ex; this.correction.y += ey; this.correction.z += ez;
        this.prev.x -= ex; this.prev.y -= ey; this.prev.z -= ez;
      }
    }
    if (!me.alive && prevMe && prevMe.alive) this.deathPos = new THREE.Vector3(this.pred.x, this.pred.y, this.pred.z);

    for (const ev of s.ev) this.handleEvent(ev);
    this.world.setPacks(s.pk);
  }

  loadServerState(me) {
    const p = this.pred;
    p.x = me.x; p.y = me.y; p.z = me.z;
    p.vx = me.vx; p.vy = me.vy; p.vz = me.vz;
    p.onGround = !!me.og;
    p.dashT = me.dt; p.dashX = me.dx; p.dashZ = me.dz;
    p.dashSeq = me.dsq;
    p.cdShift = me.cs;
  }

  setViewmodel(heroId) {
    if (this.viewmodel) this.vmScene.remove(this.viewmodel);
    this.viewmodel = buildViewmodel(heroId);
    this.viewmodel.scale.setScalar(VM[heroId].scale);
    this.vmScene.add(this.viewmodel);
    this.vmHero = heroId;
    this.hud.setHero(heroId);
  }

  // ── 보간 ───────────────────────────────────────
  sampleSnapshots(rt) {
    const S = this.snaps;
    if (!S.length) return null;
    if (rt <= S[0].tm) return { a: S[0], b: S[0], f: 0 };
    for (let i = S.length - 1; i > 0; i--) {
      if (S[i - 1].tm <= rt) {
        const a = S[i - 1], b = S[i];
        const f = b.tm > a.tm ? Math.min(1, (rt - a.tm) / (b.tm - a.tm)) : 1;
        return { a, b, f };
      }
    }
    const last = S[S.length - 1];
    return { a: last, b: last, f: 0 };
  }

  name(id) {
    const p = this.roster.get(id);
    return p ? p.name : '?';
  }

  updateRemotes(dt) {
    const smp = this.sampleSnapshots(this.renderTime);
    const seen = new Set();
    const tags = [];
    const cam = this.camera;
    const W = window.innerWidth, H = window.innerHeight;
    if (smp) {
      const { a, b, f } = smp;
      const span = Math.max(1e-3, b.tm - a.tm);
      for (const [id, pb] of b.pl) {
        const pa = a.pl.get(id) || pb;
        const heroId = HERO_IDS[pb[8]];
        if (!heroId) continue;
        seen.add(id);
        let m = this.models.get(id);
        if (!m || m.heroId !== heroId) {
          if (m) m.dispose();
          m = new HeroModel(heroId, pb[9]);
          this.scene.add(m.group);
          this.models.set(id, m);
        }
        if (m.team !== pb[9]) m.setTeam(pb[9]);
        const x = pa[1] + (pb[1] - pa[1]) * f, y = pa[2] + (pb[2] - pa[2]) * f, z = pa[3] + (pb[3] - pa[3]) * f;
        const st = {
          x, y, z,
          vx: a === b ? 0 : (pb[1] - pa[1]) / span, vz: a === b ? 0 : (pb[3] - pa[3]) / span,
          onGround: a === b ? true : Math.abs(pb[2] - pa[2]) < 0.05,
          yaw: lerpAngle(pa[4], pb[4], f), pitch: pa[5] + (pb[5] - pa[5]) * f,
          alive: !!(pb[7] & 1), flags: pb[7],
        };
        m.alive = st.alive;
        m.team = pb[9];
        m.hp = pb[6];
        m.update(dt, st);
        const revealed = !!(pb[7] & 16);
        m.setXray(revealed);
        if (!st.alive) continue;
        // 이름표·체력바
        const h = HEROES[heroId];
        tmpV.set(x, y + h.height + 0.35, z).project(cam);
        if (tmpV.z > 1 || tmpV.z < -1) continue;
        const sx = (tmpV.x * 0.5 + 0.5) * W, sy = (-tmpV.y * 0.5 + 0.5) * H;
        if (sx < -50 || sx > W + 50 || sy < -50 || sy > H + 50) continue;
        const ally = pb[9] === this.myTeam;
        const dist = cam.position.distanceTo(tmpV2.set(x, y + h.eye, z));
        let visible = ally || revealed;
        if (!visible && dist < 60) {
          const dx = x - cam.position.x, dy = y + headCenterY(h) - cam.position.y, dz = z - cam.position.z;
          const l = Math.hypot(dx, dy, dz);
          visible = !raycastMap(MAP, cam.position.x, cam.position.y, cam.position.z, dx / l, dy / l, dz / l, l - 0.3);
        }
        if (!visible) continue;
        tags.push({
          x: sx, y: sy, name: ally ? this.name(id) : '', hpFrac: pb[6] / h.hp, ally,
          revealed: revealed && !ally, showBar: ally || pb[6] < h.hp || dist < 30,
        });
      }
    }
    // 자기 모델(사망 연출용)
    const me = this.me;
    if (me && me.hero) {
      let m = this.models.get(this.myId);
      if (!m || m.heroId !== me.hero) {
        if (m) m.dispose();
        m = new HeroModel(me.hero, me.team);
        this.scene.add(m.group);
        this.models.set(this.myId, m);
      }
      seen.add(this.myId);
      m.alive = !!me.alive;
      m.update(dt, {
        x: this.renderPos.x, y: this.renderPos.y, z: this.renderPos.z, vx: 0, vz: 0, onGround: true,
        yaw: this.input.yaw, pitch: 0, alive: !!me.alive, flags: 0,
      });
      m.group.visible = !me.alive && m.group.visible;
    }
    for (const [id, m] of this.models) {
      if (!seen.has(id)) {
        m.dispose();
        this.models.delete(id);
      }
    }
    this.hud.tags(tags);

    // 엔티티
    if (smp) {
      const { a, b, f } = smp;
      const list = [];
      for (const [id, eb] of b.en) {
        const ea = a.en.get(id) || eb;
        list.push({
          id, type: eb[1], team: eb[5], extra: eb[6],
          x: ea[2] + (eb[2] - ea[2]) * f, y: ea[3] + (eb[3] - ea[3]) * f, z: ea[4] + (eb[4] - ea[4]) * f,
        });
      }
      this.world.syncEntities(list, dt);
    }
  }

  // ── 이벤트 ─────────────────────────────────────
  modelPos(id, out) {
    const m = this.models.get(id);
    if (!m) return null;
    return out.copy(m.group.position);
  }

  screenOf(pos) {
    tmpV.copy(pos).project(this.camera);
    if (tmpV.z > 1) return null;
    return [(tmpV.x * 0.5 + 0.5) * window.innerWidth, (-tmpV.y * 0.5 + 0.5) * window.innerHeight];
  }

  entityPos(id, out) {
    const last = this.snaps[this.snaps.length - 1];
    const e = last && last.en.get(id);
    return e ? out.set(e[2], e[3], e[4]) : null;
  }

  handleEvent(ev) {
    const type = ev[0];
    switch (type) {
      case 'shot': {
        const [, sid, x, y, z, hit] = ev;
        const end = new THREE.Vector3(x, y, z);
        if (sid === this.myId) {
          this.effects.impact(end, hit ? 0xff6a5a : 0xffe0a0);
          break;
        }
        if (sid < 0) {
          const p = this.entityPos(-sid, new THREE.Vector3());
          if (p) {
            p.y += 0.75;
            this.effects.tracer(p, end, 0xc6ff6a, 0.8);
            this.sfx.play('turret', p);
          }
          break;
        }
        const m = this.models.get(sid);
        if (!m) break;
        const from = m.muzzleWorld(new THREE.Vector3());
        const [color, width] = TRACER[m.heroId] || [0xffffff, 1];
        this.effects.tracer(from, end, color, width);
        this.effects.impact(end);
        if (!m.lastShotFx || performance.now() - m.lastShotFx > 30) {
          m.lastShotFx = performance.now();
          this.effects.muzzle(from);
          this.sfx.play(SHOT_SOUND[m.heroId], from);
          m.kick();
        }
        break;
      }
      case 'fire': {
        const m = this.models.get(ev[1]);
        if (!m || ev[1] === this.myId) break;
        const from = m.muzzleWorld(new THREE.Vector3());
        this.effects.muzzle(from, m.heroId === 'sol' ? 0xffe36b : 0xff9a2e);
        this.sfx.play(SHOT_SOUND[m.heroId], from);
        m.kick();
        break;
      }
      case 'hit': {
        const [, tid, dmg, head, kill] = ev;
        this.hud.hitmarker(head, kill);
        this.sfx.play(kill ? 'kill' : head ? 'head' : 'hit');
        const pos = tid > 0 ? this.modelPos(tid, new THREE.Vector3()) : this.entityPos(-tid, new THREE.Vector3());
        if (pos) {
          const m = tid > 0 ? this.models.get(tid) : null;
          pos.y += m ? m.hero.height + 0.1 : 1;
          const sc = this.screenOf(pos);
          if (sc) this.hud.dmgNumber(sc[0] + (Math.random() - 0.5) * 30, sc[1], dmg, head ? 'head' : '');
        }
        break;
      }
      case 'healed': {
        const pos = this.modelPos(ev[1], new THREE.Vector3());
        if (pos) {
          const m = this.models.get(ev[1]);
          pos.y += m.hero.height + 0.1;
          const sc = this.screenOf(pos);
          if (sc) this.hud.dmgNumber(sc[0], sc[1], `+${ev[2]}`, 'heal');
        }
        break;
      }
      case 'dmg': {
        const [, x, , z] = ev;
        const dx = x - this.pred.x, dz = z - this.pred.z;
        if (Math.hypot(dx, dz) > 0.5) {
          const src = Math.atan2(-dx, -dz);
          this.hud.damageDir(-(src - this.input.yaw));
        } else {
          this.hud.damageDir(0);
        }
        this.sfx.play('hurt');
        break;
      }
      case 'kill': {
        const [, kid, vid, cause] = ev;
        const killer = kid ? this.roster.get(kid) : null;
        const victim = this.roster.get(vid);
        if (victim) this.hud.killfeed(killer, victim, cause, kid === this.myId || vid === this.myId);
        if (kid === this.myId && vid !== this.myId && victim) this.hud.toast(`처치: ${victim.name}`);
        if (vid === this.myId) {
          this.hud.announce('사망', killer && kid !== this.myId ? `${killer.name}에게 처치당했습니다` : '', '#ff8f8f', 2);
          this.input.mouse = 0;
        }
        break;
      }
      case 'boom': {
        const [, x, y, z, r, kind] = ev;
        const p = new THREE.Vector3(x, y, z);
        this.effects.explosion(p, r * (kind === 'slam' ? 0.6 : 0.8), BOOM_COLOR[kind] || 0xff8a2a);
        if (kind === 'slam') this.effects.ring(p, r, 0xe8a050, 0.5);
        this.sfx.play(kind === 'slam' ? 'slam' : r > 2 ? 'boom' : 'smallboom', p);
        const d = p.distanceTo(this.camera.position);
        this.shake = Math.max(this.shake, Math.max(0, 1 - d / (r * 5)) * (kind === 'slam' ? 1 : 0.6));
        break;
      }
      case 'puff':
        this.effects.impact(new THREE.Vector3(ev[1], ev[2], ev[3]), ev[4] ? 0x9cff9c : 0xffe36b);
        break;
      case 'pulse': {
        const p = new THREE.Vector3(ev[1], ev[2], ev[3]);
        this.effects.ring(p, ev[4], 0xffd76a, 0.6);
        this.sfx.play('pulse', p);
        break;
      }
      case 'mark':
        this.effects.marker(new THREE.Vector3(ev[1], ev[2], ev[3]), ev[4], ev[5] === this.myTeam ? 0xffa040 : 0xff2020, ev[6]);
        break;
      case 'move': {
        if (ev[1] === this.myId) break;
        const p = this.modelPos(ev[1], new THREE.Vector3());
        if (p) this.sfx.play(ev[2] === 'dash' ? 'dash' : 'jump', p);
        break;
      }
      case 'ult': {
        const [, id, heroId, team] = ev;
        const ally = team === this.myTeam;
        this.sfx.play(ally ? 'ult-ally' : 'ult-enemy');
        const who = this.roster.get(id);
        if (id !== this.myId) this.hud.chat(null, team, `${ally ? '아군' : '적'} ${HEROES[heroId].name}${who ? `(${who.name})` : ''} — ${HEROES[heroId].q.name}!`);
        break;
      }
      case 'cap': {
        const mine = ev[1] === this.myTeam;
        this.hud.announce(mine ? '거점을 점령했습니다' : '거점을 빼앗겼습니다', '', TEAM_COLORS[ev[1]], 2.4);
        this.sfx.play('cap');
        break;
      }
      case 'phase': {
        const [, phase, winner] = ev;
        if (phase === 'live') this.hud.announce('경기 시작', '중앙 거점을 점령하십시오', '#ffd479', 2.6);
        else if (phase === 'end') this.hud.announce(winner === this.myTeam ? '승리!' : '패배', winner === this.myTeam ? '거점을 지켜냈습니다' : '다음 경기를 준비하세요', winner === this.myTeam ? '#ffd479' : '#ff8f8f', 5);
        else if (phase === 'warmup') this.hud.announce('새 경기 준비', '히어로를 바꾸려면 H', '#fff', 2.4);
        this.sfx.play('cap');
        break;
      }
      case 'chat': {
        const p = this.roster.get(ev[1]);
        this.hud.chat(p ? p.name : '?', p ? p.team : 0, ev[2]);
        break;
      }
      case 'info':
        this.hud.chat(null, 0, ev[1]);
        break;
      case 'pack':
        this.sfx.play('pack');
        this.hud.toast(`체력 +${ev[1]}`, 1.2);
        break;
      default:
        break;
    }
  }

  // ── 프레임 ─────────────────────────────────────
  frame(now) {
    let dt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    if (dt > 0.25) dt = 0.25;
    if (this.net.clockOffset !== null) this.renderTime = this.net.serverTime() - INTERP_DELAY;

    this.acc += dt;
    while (this.acc >= DT) {
      this.step();
      this.acc -= DT;
    }
    this.flushInput();

    const me = this.me;
    const hero = this.myHero;
    const alpha = this.acc / DT;
    this.correction.multiplyScalar(Math.exp(-dt * 14));
    this.renderPos.set(
      this.prev.x + (this.pred.x - this.prev.x) * alpha + this.correction.x,
      this.prev.y + (this.pred.y - this.prev.y) * alpha + this.correction.y,
      this.prev.z + (this.pred.z - this.prev.z) * alpha + this.correction.z,
    );

    // 카메라
    const cam = this.camera;
    if (me && hero) {
      if (me.alive) {
        cam.position.set(this.renderPos.x, this.renderPos.y + hero.eye, this.renderPos.z);
        cam.rotation.set(this.input.pitch, this.input.yaw, 0);
      } else {
        const dp = this.deathPos || this.renderPos;
        const back = forwardVec(this.input.yaw, 0);
        cam.position.set(dp.x - back[0] * 3.5, dp.y + 2.6, dp.z - back[2] * 3.5);
        cam.lookAt(dp.x, dp.y + 0.5, dp.z);
      }
    }
    if (this.shake > 0.001) {
      cam.position.x += (Math.random() - 0.5) * this.shake * 0.25;
      cam.position.y += (Math.random() - 0.5) * this.shake * 0.25;
      this.shake *= Math.exp(-dt * 7);
    }
    // 줌(루크)·이동기 FOV 연출
    const zooming = hero && hero.weapon.zoomFov && me.alive && (this.input.buttons() & BTN.ALT);
    this.zoom += ((zooming ? 1 : 0) - this.zoom) * Math.min(1, dt * 14);
    this.fovKick = Math.max(0, (this.fovKick || 0) - dt * 3);
    const baseFov = this.settings.fov;
    cam.fov = baseFov + (hero && hero.weapon.zoomFov ? (hero.weapon.zoomFov - baseFov) * this.zoom : 0) + this.fovKick * 6;
    cam.updateProjectionMatrix();
    this.input.sensScale = zooming ? 0.4 : 1;
    this.hud.scope(this.zoom > 0.6);
    cam.updateMatrixWorld();

    this.updateRemotes(dt);
    this.effects.update(dt);
    this.world.setPoint(this.ob[2], this.ob[3], this.ob[4], this.ob[0] === 1);

    // 발소리
    if (me && me.alive && this.pred.onGround) {
      const sp = Math.hypot(this.pred.vx, this.pred.vz);
      if (sp > 2) {
        this.stepT -= dt * sp / 5.5;
        if (this.stepT <= 0) { this.stepT = 0.36; this.sfx.play('step'); }
      }
    }

    this.updateViewmodel(dt);
    if (me) {
      this.hud.updateMe(me);
      this.hud.updateObjective(this.ob, this.myTeam);
    }
    const fwd = tmpV2.set(0, 0, -1).applyQuaternion(cam.quaternion);
    this.sfx.setListener(cam.position, fwd);

    this.renderer.clear();
    this.renderer.render(this.scene, cam);
    if (this.viewmodel && me && me.alive && this.zoom < 0.6) {
      this.renderer.clearDepth();
      this.renderer.render(this.vmScene, this.vmCamera);
    }
  }

  updateViewmodel(dt) {
    const vm = this.viewmodel;
    const me = this.me;
    if (!vm || !me) return;
    const hero = this.myHero;
    const sp = Math.hypot(this.pred.vx, this.pred.vz);
    const moveF = this.pred.onGround ? Math.min(1, sp / hero.speed) : 0;
    this.bobT += dt * (6 + sp * 0.9) * (moveF > 0.05 ? 1 : 0.3);
    this.recoil = Math.max(0, this.recoil - dt * (hero.weapon.interval < 0.2 ? 14 : 6));
    const reload = me.rl > 0 ? Math.sin(Math.min(1, 1 - me.rl / hero.weapon.reload) * Math.PI) : 0;
    const [bx, by, bz] = VM[hero.id].pos;
    vm.position.set(
      bx + Math.sin(this.bobT) * 0.012 * moveF,
      by + Math.abs(Math.cos(this.bobT)) * 0.012 * moveF - reload * 0.12 - (this.pred.onGround ? 0 : 0.02),
      bz + this.recoil * 0.06,
    );
    vm.rotation.set(this.recoil * 0.08 - reload * 0.6, 0, reload * 0.3);
    this.vmCamera.position.set(0, 0, 0);
    this.vmCamera.rotation.set(0, 0, 0);
  }

  // ── UI 연동 ────────────────────────────────────
  setScoreboard(on) {
    this.scoreboardOn = on;
    this.hud.scoreboard(on, [...this.roster.values()], this.myId);
  }

  canChangeHeroNow() {
    const me = this.me;
    if (!me || !me.hero || !me.alive) return true;
    const z = MAP.spawnZones[me.team];
    const p = this.pred;
    return p.x >= z.min[0] && p.x <= z.max[0] && p.z >= z.min[2] && p.z <= z.max[2];
  }
}
