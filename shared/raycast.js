// 광선 판정: 맵 박스, 플레이어 히트박스(몸통 AABB + 머리 구), 구.
import { headCenterY, bodyTopY } from './heroes.js';

// 슬랩 방식. 맞으면 진입 거리 t(0 이상), 아니면 -1. 시작점이 안쪽이면 0.
export function rayBox(ox, oy, oz, dx, dy, dz, x0, y0, z0, x1, y1, z1, maxT) {
  let tmin = 0;
  let tmax = maxT;
  // x
  if (Math.abs(dx) < 1e-12) {
    if (ox < x0 || ox > x1) return -1;
  } else {
    let t1 = (x0 - ox) / dx, t2 = (x1 - ox) / dx;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  // y
  if (Math.abs(dy) < 1e-12) {
    if (oy < y0 || oy > y1) return -1;
  } else {
    let t1 = (y0 - oy) / dy, t2 = (y1 - oy) / dy;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  // z
  if (Math.abs(dz) < 1e-12) {
    if (oz < z0 || oz > z1) return -1;
  } else {
    let t1 = (z0 - oz) / dz, t2 = (z1 - oz) / dz;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  return tmin;
}

// 맵에 대한 광선. inflate 만큼 박스를 키워 구(반지름 inflate)의 이동 판정에도 쓴다.
// 반환: { t, nx, ny, nz } 또는 null
export function raycastMap(map, ox, oy, oz, dx, dy, dz, maxT, inflate = 0) {
  const b = map.b;
  let best = maxT;
  let bestO = -1;
  for (let i = 0; i < map.n; i++) {
    const o = i * 6;
    const t = rayBox(ox, oy, oz, dx, dy, dz,
      b[o] - inflate, b[o + 1] - inflate, b[o + 2] - inflate,
      b[o + 3] + inflate, b[o + 4] + inflate, b[o + 5] + inflate, best);
    if (t >= 0 && t < best) {
      best = t;
      bestO = o;
    }
  }
  if (bestO < 0) return null;
  // 맞은 면의 법선: 충돌점이 가장 가까이 붙은 면
  const px = ox + dx * best, py = oy + dy * best, pz = oz + dz * best;
  const o = bestO;
  const d = [
    Math.abs(px - (b[o] - inflate)), Math.abs(px - (b[o + 3] + inflate)),
    Math.abs(py - (b[o + 1] - inflate)), Math.abs(py - (b[o + 4] + inflate)),
    Math.abs(pz - (b[o + 2] - inflate)), Math.abs(pz - (b[o + 5] + inflate)),
  ];
  let k = 0;
  for (let i = 1; i < 6; i++) if (d[i] < d[k]) k = i;
  const n = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]][k];
  return { t: best, nx: n[0], ny: n[1], nz: n[2] };
}

// 구 진입 거리 또는 -1
export function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r, maxT) {
  const lx = ox - cx, ly = oy - cy, lz = oz - cz;
  const b = lx * dx + ly * dy + lz * dz;
  const c = lx * lx + ly * ly + lz * lz - r * r;
  if (c <= 0) return 0;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t >= 0 && t <= maxT ? t : -1;
}

// 플레이어 히트박스. 반환 { t, head } 또는 null
export function rayPlayer(ox, oy, oz, dx, dy, dz, px, py, pz, hero, maxT, inflate = 0) {
  let best = null;
  const hr = hero.headRadius * 1.1 + inflate;
  const th = raySphere(ox, oy, oz, dx, dy, dz, px, py + headCenterY(hero), pz, hr, maxT);
  if (th >= 0) best = { t: th, head: true };
  const r = hero.radius + inflate;
  const tb = rayBox(ox, oy, oz, dx, dy, dz, px - r, py - inflate, pz - r, px + r, py + bodyTopY(hero) + inflate, pz + r,
    best ? best.t : maxT);
  if (tb >= 0 && (!best || tb < best.t)) best = { t: tb, head: false };
  return best;
}

// 두 점 사이 시야가 맵에 막히지 않는지
export function hasLineOfSight(map, ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return true;
  return raycastMap(map, ax, ay, az, dx / len, dy / len, dz / len, len - 0.05) === null;
}
