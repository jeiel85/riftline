// 서버 측 봇. 사람과 똑같이 입력 명령(cmd)을 만들어 같은 판정 경로를 탄다.
import { HEROES } from '../shared/heroes.js';
import { BTN } from '../shared/constants.js';
import { hasLineOfSight } from '../shared/raycast.js';

const TAU = Math.PI * 2;

function angleDiff(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

export const BOT_NAMES = ['알파', '브라보', '찰리', '델타', '에코', '폭스', '골프', '호텔', '인디고', '줄리엣'];

export class BotBrain {
  constructor(room, player, rng = Math.random) {
    this.room = room;
    this.p = player;
    this.rng = rng;
    this.seq = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.path = null;
    this.pathIdx = 0;
    this.goal = null;
    this.repathAt = 0;
    this.target = null;
    this.targetSince = 0;
    this.thinkAt = 0;
    this.strafe = 1;
    this.strafeUntil = 0;
    this.stuckCheckAt = 0;
    this.stuckPos = [0, 0];
    this.jumpUntil = 0;
    this.goalOffset = [0, 0];
    this.reaction = 0.25 + this.rng() * 0.2;
    this.aimError = 0.02 + this.rng() * 0.03;
    this.wasAlive = false;
  }

  think() {
    const room = this.room, p = this.p, now = room.time;
    const cmd = { seq: this.seq++, mx: 0, mz: 0, yaw: this.yaw, pitch: this.pitch, buttons: 0, rt: now };
    if (!p.alive || !p.hero) {
      this.wasAlive = false;
      this.path = null;
      this.target = null;
      return cmd;
    }
    const hero = HEROES[p.hero];
    const m = p.move;
    if (!this.wasAlive) {
      this.wasAlive = true;
      this.yaw = p.yaw;
      this.pitch = 0;
      this.goalOffset = [(this.rng() - 0.5) * 5, (this.rng() - 0.5) * 5];
    }
    const eyeY = m.y + hero.eye;

    // ── 목표 탐색(0.2초마다) ──
    if (now >= this.thinkAt) {
      this.thinkAt = now + 0.2;
      const prev = this.target;
      this.target = this.pickTarget(m.x, eyeY, m.z, hero);
      if (this.target !== prev) this.targetSince = now;
    }

    // ── 이동 목표 ──
    let goal = this.pickGoal(hero);
    if (goal && (!this.goal || Math.hypot(goal[0] - this.goal[0], goal[2] - this.goal[2]) > 2.5 || now >= this.repathAt)) {
      this.goal = goal;
      this.path = room.nav.findPath(m.x, m.y, m.z, goal[0], goal[1], goal[2]);
      this.pathIdx = 0;
      this.repathAt = now + 1.5 + this.rng();
    }

    let mvx = 0, mvz = 0;
    if (this.path && this.pathIdx < this.path.length) {
      let wp = this.path[this.pathIdx];
      while (Math.hypot(wp[0] - m.x, wp[2] - m.z) < 0.6 && this.pathIdx < this.path.length - 1) {
        wp = this.path[++this.pathIdx];
      }
      const dx = wp[0] - m.x, dz = wp[2] - m.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.4) {
        mvx = dx / d; mvz = dz / d;
      } else if (this.pathIdx === this.path.length - 1) {
        this.path = null;
      }
    }

    // ── 교전 ──
    const t = this.target;
    let wantFire = false;
    if (t) {
      const th = HEROES[t.hero];
      const tm = t.move;
      let ax = tm.x, ay = tm.y + th.height * 0.6, az = tm.z;
      const w = hero.weapon;
      if (w.type === 'projectile') {
        const dist = Math.hypot(ax - m.x, ay - eyeY, az - m.z);
        const tt = dist / w.speed;
        ax += tm.vx * tt; az += tm.vz * tt;
        if (p.hero === 'ember') ay = tm.y + 0.3; // 발밑을 노려 스플래시
      }
      const dx = ax - m.x, dy = ay - eyeY, dz = az - m.z;
      const hd = Math.hypot(dx, dz);
      const wantYaw = Math.atan2(-dx, -dz) + (this.rng() - 0.5) * this.aimError;
      const wantPitch = Math.atan2(dy, hd) + (this.rng() - 0.5) * this.aimError;
      const turn = 7 * room.dt;
      const dyaw = angleDiff(this.yaw, wantYaw);
      this.yaw += Math.max(-turn, Math.min(turn, dyaw));
      this.pitch += Math.max(-turn, Math.min(turn, wantPitch - this.pitch));
      const err = Math.abs(angleDiff(this.yaw, wantYaw)) + Math.abs(wantPitch - this.pitch);
      const tol = Math.max(0.04, Math.atan2(0.5, Math.max(1, Math.hypot(dx, dy, dz))));
      wantFire = now - this.targetSince > this.reaction && err < tol * 1.6;
      if (p.hero === 'sol' && t.team === p.team) wantFire = err < tol * 2; // 아군 치유

      // 교전 중 좌우 이동
      if (now >= this.strafeUntil) {
        this.strafe = this.rng() < 0.5 ? -1 : 1;
        this.strafeUntil = now + 0.5 + this.rng() * 0.9;
      }
      const engageDist = Math.hypot(dx, dz);
      const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
      const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
      const close = p.hero === 'kodiak' ? 3 : p.hero === 'rook' ? 18 : 9;
      if (t.team !== p.team && engageDist < close) {
        mvx = rx * this.strafe; mvz = rz * this.strafe;
        if (engageDist < close * 0.5) { mvx -= fx * 0.7; mvz -= fz * 0.7; }
      } else {
        mvx = mvx * 0.6 + rx * this.strafe * 0.6;
        mvz = mvz * 0.6 + rz * this.strafe * 0.6;
      }
      this.useAbilities(cmd, hero, t, engageDist);
    } else if (mvx || mvz) {
      const wantYaw = Math.atan2(-mvx, -mvz);
      const turn = 5 * room.dt;
      this.yaw += Math.max(-turn, Math.min(turn, angleDiff(this.yaw, wantYaw)));
      this.pitch *= 0.9;
    }

    // 막힘 감지 → 점프
    if (now >= this.stuckCheckAt) {
      const moved = Math.hypot(m.x - this.stuckPos[0], m.z - this.stuckPos[1]);
      if ((mvx || mvz) && moved < 0.3) {
        this.jumpUntil = now + 0.3;
        this.repathAt = 0;
      }
      this.stuckPos = [m.x, m.z];
      this.stuckCheckAt = now + 0.7;
    }
    if (now < this.jumpUntil) cmd.buttons |= BTN.JUMP;

    // 월드 방향 → 로컬 입력
    const len = Math.hypot(mvx, mvz);
    if (len > 0.01) {
      mvx /= len; mvz /= len;
      const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
      const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
      cmd.mz = mvx * fx + mvz * fz;
      cmd.mx = mvx * rx + mvz * rz;
    }
    if (wantFire) cmd.buttons |= BTN.FIRE;
    if (!t && p.ammo < hero.weapon.mag * 0.4) cmd.buttons |= BTN.RELOAD;
    cmd.yaw = this.yaw;
    cmd.pitch = Math.max(-1.4, Math.min(1.4, this.pitch));
    return cmd;
  }

  pickTarget(x, ey, z, hero) {
    const room = this.room, p = this.p;
    let best = null, bestScore = Infinity;
    const range = hero.weapon.type === 'hitscan' ? Math.min(hero.weapon.range, 55) : 40;
    for (const o of room.players.values()) {
      if (o === p || !o.alive || !o.hero) continue;
      const oh = HEROES[o.hero];
      const ally = o.team === p.team;
      if (ally && (p.hero !== 'sol' || o.hp >= oh.hp * 0.85)) continue;
      const d = Math.hypot(o.move.x - x, o.move.z - z, o.move.y + oh.eye - ey);
      if (d > range) continue;
      if (!hasLineOfSight(room.map, x, ey, z, o.move.x, o.move.y + oh.height * 0.6, o.move.z)) continue;
      let score = d + (o === this.target ? -6 : 0);
      if (ally) score -= 10 + (1 - o.hp / oh.hp) * 20; // 솔은 다친 아군을 우선
      if (score < bestScore) { bestScore = score; best = o; }
    }
    return best;
  }

  pickGoal(hero) {
    const room = this.room, p = this.p, m = p.move;
    // 체력이 낮으면 가까운 회복 팩
    if (p.hp < hero.hp * 0.4) {
      let best = null, bd = 22;
      for (const pk of room.packs) {
        if (!pk.available) continue;
        const d = Math.hypot(pk.pos[0] - m.x, pk.pos[2] - m.z);
        if (d < bd) { bd = d; best = pk.pos; }
      }
      if (best) return best;
    }
    const pt = room.map.point.pos;
    return [pt[0] + this.goalOffset[0], pt[1], pt[2] + this.goalOffset[1]];
  }

  useAbilities(cmd, hero, t, dist) {
    const p = this.p, room = this.room;
    const enemy = t.team !== p.team;
    const ultReady = p.ult >= hero.ultCost;
    const r = this.rng();
    switch (p.hero) {
      case 'kodiak':
        if (enemy && dist < 7 && p.move.cdShift <= 0 && r < 0.05) cmd.buttons |= BTN.SHIFT;
        if (p.hp < hero.hp * 0.6 && p.cdE <= 0) cmd.buttons |= BTN.E;
        if (ultReady && enemy && dist < 7) cmd.buttons |= BTN.Q;
        break;
      case 'vex':
        if (enemy && p.move.cdShift <= 0 && r < 0.02) cmd.buttons |= BTN.SHIFT;
        if (enemy && dist < 14 && p.cdE <= 0 && r < 0.05) cmd.buttons |= BTN.E;
        if (ultReady && enemy) cmd.buttons |= BTN.Q;
        break;
      case 'ember':
        if (enemy && p.move.cdShift <= 0 && r < 0.01) cmd.buttons |= BTN.SHIFT;
        if (enemy && dist < 18 && p.cdE <= 0 && r < 0.04) cmd.buttons |= BTN.E;
        if (ultReady && enemy && dist < 35) cmd.buttons |= BTN.Q;
        break;
      case 'rook':
        if (enemy && dist < 6 && p.move.cdShift <= 0) cmd.buttons |= BTN.SHIFT;
        if (enemy && p.cdE <= 0 && r < 0.03) cmd.buttons |= BTN.E;
        if (ultReady && enemy) cmd.buttons |= BTN.Q;
        break;
      case 'sol': {
        if (p.hp < hero.hp * 0.5 && p.move.cdShift <= 0 && enemy) cmd.buttons |= BTN.SHIFT;
        let hurt = 0;
        for (const o of room.players.values()) {
          if (!o.alive || o.team !== p.team || !o.hero) continue;
          if (Math.hypot(o.move.x - p.move.x, o.move.z - p.move.z) > 8) continue;
          if (o.hp < HEROES[o.hero].hp * 0.7) hurt++;
        }
        if (hurt >= 1 && p.cdE <= 0) cmd.buttons |= BTN.E;
        if (ultReady && hurt >= 2) cmd.buttons |= BTN.Q;
        break;
      }
    }
  }
}
