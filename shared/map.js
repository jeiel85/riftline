// 맵 데이터를 충돌 계산용 Float64Array 로 컴파일한다.
import data from './map-data.json' with { type: 'json' };

export function compileMap(src) {
  const n = src.boxes.length;
  const b = new Float64Array(n * 6);
  src.boxes.forEach((box, i) => {
    b.set(box.min, i * 6);
    b.set(box.max, i * 6 + 3);
  });
  return { ...src, n, b };
}

export const MAP = compileMap(data);

export function inBox(box, x, y, z) {
  return x >= box.min[0] && x <= box.max[0] && y >= box.min[1] && y <= box.max[1] && z >= box.min[2] && z <= box.max[2];
}

// 좌표가 어느 팀 스폰 구역 안인지(-1: 없음)
export function spawnZoneTeam(map, x, y, z) {
  for (let t = 0; t < map.spawnZones.length; t++) {
    if (inBox(map.spawnZones[t], x, y + 0.1, z)) return t;
  }
  return -1;
}

// (x,z) 발자국(반지름 r) 아래에서 yFrom 이하의 가장 높은 바닥 높이. 없으면 -Infinity.
export function groundHeightAt(map, x, z, yFrom, r = 0) {
  const b = map.b;
  let best = -Infinity;
  for (let i = 0; i < map.n; i++) {
    const o = i * 6;
    if (x + r <= b[o] || x - r >= b[o + 3] || z + r <= b[o + 2] || z - r >= b[o + 5]) continue;
    const top = b[o + 4];
    if (top <= yFrom + 1e-6 && top > best) best = top;
  }
  return best;
}
