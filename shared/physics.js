// 플레이어 이동·충돌. 서버 판정과 클라이언트 예측이 같은 코드를 써야 보정(snap)이 생기지 않는다.
// 플레이어는 발 중심 기준 AABB(반폭 r, 높이 h), 맵은 AABB 목록.
import { PHYS, BTN } from './constants.js';

const EPS = 1e-4;

export function createMoveState(pos) {
  return {
    x: pos[0], y: pos[1], z: pos[2],
    vx: 0, vy: 0, vz: 0,
    onGround: false,
    dashT: 0, dashX: 0, dashZ: 0,
    dashSeq: 0,      // 이동기 사용 횟수(서버가 돌진 피해 판정 리셋에 사용)
    cdShift: 0,
  };
}

export function copyMoveState(dst, src) {
  dst.x = src.x; dst.y = src.y; dst.z = src.z;
  dst.vx = src.vx; dst.vy = src.vy; dst.vz = src.vz;
  dst.onGround = src.onGround;
  dst.dashT = src.dashT; dst.dashX = src.dashX; dst.dashZ = src.dashZ;
  dst.dashSeq = src.dashSeq;
  dst.cdShift = src.cdShift;
  return dst;
}

export function forwardVec(yaw, pitch) {
  const cp = Math.cos(pitch);
  return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
}

// 플레이어 AABB 와 겹치는 박스 인덱스를 cb 로 넘긴다.
function forOverlaps(map, x, y, z, r, h, cb) {
  const b = map.b;
  const x0 = x - r, x1 = x + r, y0 = y, y1 = y + h, z0 = z - r, z1 = z + r;
  for (let i = 0; i < map.n; i++) {
    const o = i * 6;
    if (x0 < b[o + 3] && x1 > b[o] && y0 < b[o + 4] && y1 > b[o + 1] && z0 < b[o + 5] && z1 > b[o + 2]) {
      cb(o);
    }
  }
}

export function collides(map, x, y, z, r, h) {
  const b = map.b;
  const x0 = x - r, x1 = x + r, y0 = y, y1 = y + h, z0 = z - r, z1 = z + r;
  for (let i = 0; i < map.n; i++) {
    const o = i * 6;
    if (x0 < b[o + 3] && x1 > b[o] && y0 < b[o + 4] && y1 > b[o + 1] && z0 < b[o + 5] && z1 > b[o + 2]) return true;
  }
  return false;
}

// 수평 한 축 이동. axis 0 = x, 2 = z. 계단(stepHeight 이하)은 올라선다.
function moveHoriz(st, axis, delta, r, h, map, canStep) {
  if (delta === 0) return;
  const key = axis === 0 ? 'x' : 'z';
  const vkey = axis === 0 ? 'vx' : 'vz';
  const target = st[key] + delta;
  const tx = axis === 0 ? target : st.x;
  const tz = axis === 0 ? st.z : target;

  let hitAny = false;
  let topMax = -Infinity;
  let clamp = delta > 0 ? Infinity : -Infinity;
  const b = map.b;
  forOverlaps(map, tx, st.y, tz, r, h, (o) => {
    hitAny = true;
    if (b[o + 4] > topMax) topMax = b[o + 4];
    if (delta > 0) clamp = Math.min(clamp, b[o + axis] - r - EPS);
    else clamp = Math.max(clamp, b[o + 3 + axis] + r + EPS);
  });
  if (!hitAny) {
    st[key] = target;
    return;
  }
  if (canStep) {
    const rise = topMax - st.y;
    if (rise > 0 && rise <= PHYS.stepHeight + 1e-6 && !collides(map, tx, topMax, tz, r, h)) {
      st[key] = target;
      st.y = topMax;
      return;
    }
  }
  // 이동 방향 기준 가장 가까운 면에 붙인다. 원래 위치보다 뒤로 밀리지 않게.
  st[key] = delta > 0 ? Math.max(st[key], Math.min(target, clamp)) : Math.min(st[key], Math.max(target, clamp));
  st[vkey] = 0;
}

function moveVert(st, r, h, map, dt, wasGround) {
  const b = map.b;
  const ny = st.y + st.vy * dt;
  let hitAny = false;
  let top = -Infinity;
  let bottom = Infinity;
  forOverlaps(map, st.x, ny, st.z, r, h, (o) => {
    hitAny = true;
    if (b[o + 4] > top) top = b[o + 4];
    if (b[o + 1] < bottom) bottom = b[o + 1];
  });
  if (!hitAny) {
    st.y = ny;
    st.onGround = false;
  } else if (st.vy <= 0) {
    st.y = Math.max(top, ny);
    st.vy = 0;
    st.onGround = true;
  } else {
    st.y = Math.min(st.y, bottom - h - EPS);
    st.vy = 0;
    st.onGround = false;
  }
  // 계단·턱을 내려갈 때 공중에 뜨지 않도록 바닥에 붙인다(점프 중이 아닐 때만).
  if (wasGround && !st.onGround && st.vy <= 0) {
    let best = -Infinity;
    const x0 = st.x - r, x1 = st.x + r, z0 = st.z - r, z1 = st.z + r;
    for (let i = 0; i < map.n; i++) {
      const o = i * 6;
      if (x0 >= b[o + 3] || x1 <= b[o] || z0 >= b[o + 5] || z1 <= b[o + 2]) continue;
      const t = b[o + 4];
      if (t <= st.y + EPS && t >= st.y - PHYS.stepHeight && t > best) best = t;
    }
    if (best > -Infinity && !collides(map, st.x, best, st.z, r, h)) {
      st.y = best;
      st.vy = 0;
      st.onGround = true;
    }
  }
}

/**
 * 고정 dt 한 스텝 이동.
 * cmd: { mx, mz (-1..1, 오른쪽/앞), yaw, pitch, buttons }
 * mods: { speedMult, noShift }
 */
export function stepMove(st, cmd, hero, mods, map, dt) {
  const r = hero.radius;
  const h = hero.height;
  const speed = hero.speed * (mods && mods.speedMult ? mods.speedMult : 1);
  const sh = hero.shift;

  if (st.cdShift > 0) st.cdShift = Math.max(0, st.cdShift - dt);

  const fx = -Math.sin(cmd.yaw);
  const fz = -Math.cos(cmd.yaw);
  const rx = Math.cos(cmd.yaw);
  const rz = -Math.sin(cmd.yaw);
  let wx = fx * cmd.mz + rx * cmd.mx;
  let wz = fz * cmd.mz + rz * cmd.mx;
  let wl = Math.hypot(wx, wz);
  if (wl > 1) {
    wx /= wl; wz /= wl; wl = 1;
  }

  if ((cmd.buttons & BTN.SHIFT) && st.cdShift <= 0 && st.dashT <= 0 && !(mods && mods.noShift)) {
    st.cdShift = sh.cooldown;
    st.dashSeq++;
    if (sh.type === 'dash') {
      let dx = fx, dz = fz;
      if (sh.dir === 'input' && wl > 0.1) {
        dx = wx / wl; dz = wz / wl;
      }
      st.dashT = sh.duration;
      st.dashX = dx;
      st.dashZ = dz;
    } else if (sh.type === 'impulse') {
      st.vy = sh.up;
      st.vx -= fx * sh.back;
      st.vz -= fz * sh.back;
      st.onGround = false;
    }
  }

  const wasGround = st.onGround;
  if (st.dashT > 0) {
    st.dashT = Math.max(0, st.dashT - dt);
    st.vx = st.dashX * sh.speed;
    st.vz = st.dashZ * sh.speed;
    st.vy = 0;
    if (st.dashT === 0) {
      st.vx *= 0.35;
      st.vz *= 0.35;
    }
  } else {
    if (st.onGround) {
      // 목표 속도로 선형 접근(지상)
      const tx = wx * speed - st.vx;
      const tz = wz * speed - st.vz;
      const tl = Math.hypot(tx, tz);
      const maxd = PHYS.groundAccel * dt;
      if (tl <= maxd) {
        st.vx += tx; st.vz += tz;
      } else {
        st.vx += (tx / tl) * maxd; st.vz += (tz / tl) * maxd;
      }
      if (cmd.buttons & BTN.JUMP) {
        st.vy = PHYS.jumpVel;
        st.onGround = false;
      }
    } else if (wl > 0.01) {
      // 공중 제어: 입력 방향 속도 성분만 wishSpeed 까지 올린다(넉백 관성 유지)
      const dx = wx / wl, dz = wz / wl;
      const wish = speed * wl;
      const cur = st.vx * dx + st.vz * dz;
      const add = wish - cur;
      if (add > 0) {
        const acc = Math.min(add, PHYS.airAccel * dt);
        st.vx += acc * dx;
        st.vz += acc * dz;
      }
    }
    st.vy = Math.max(st.vy - PHYS.gravity * dt, -PHYS.maxFall);
  }

  const canStep = wasGround && st.vy <= 0;
  moveHoriz(st, 0, st.vx * dt, r, h, map, canStep);
  moveHoriz(st, 2, st.vz * dt, r, h, map, canStep);
  moveVert(st, r, h, map, dt, wasGround && st.vy <= 0);
}
