// 맵 레이아웃 생성기. shared/map-data.json 을 만든다.
// 충돌(서버·클라이언트 예측)과 블렌더 비주얼이 모두 이 JSON 하나를 기준으로 한다.
// 실행: npm run gen:map
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const boxes = [];
const half = []; // 청색 팀 쪽(x<0)에만 정의하고 x축 대칭으로 복제할 박스

function box(list, kind, x0, y0, z0, x1, y1, z1) {
  list.push({
    kind,
    min: [Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)],
    max: [Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)],
  });
}
const B = (...a) => box(boxes, ...a);
const H = (...a) => box(half, ...a);

// 계단: (x0..x1) 폭, z 방향으로 올라가는 계단. 꼭대기 높이 top, 칸 높이 0.5.
function stairsZ(list, x0, x1, zTop, dir, top, stepDepth = 0.6) {
  const steps = Math.round(top / 0.5);
  for (let k = 1; k <= steps; k++) {
    const depth = (steps - k + 1) * stepDepth;
    const zFar = zTop - dir * depth;
    box(list, 'stairs', x0, 0, zFar, x1, k * 0.5, zTop);
  }
}

// ── 공통(대칭 없음) ──────────────────────────────
B('ground', -44, -1, -28, 44, 0, 28);
B('wall', -44, 0, 26, 44, 9, 27);     // 북쪽 외벽
B('wall', -44, 0, -27, 44, 9, -26);   // 남쪽 외벽
B('wall', -44, 0, -27, -43, 9, 27);   // 서쪽 외벽
B('wall', 43, 0, -27, 44, 9, 27);     // 동쪽 외벽

// 중앙 거점 플랫폼
B('point', -6, 0, -6, 6, 0.5, 6);
// 북쪽 고지대를 잇는 다리(아래로 통과 가능)
B('bridge', -14, 2.6, 20, 14, 3, 23);
B('railing', -14, 3, 19.8, 14, 3.9, 20);
// 남쪽 중앙 낮은 엄폐벽
B('cover', -3, 0, -15, 3, 1.2, -14);
// 다리 밑 상자
B('crate', -1, 0, 21, 1, 1.4, 23);

// ── 청색 팀 쪽 절반(x<0) — 적색 팀 쪽은 대칭 복제 ─────────
// 스폰 건물
H('spawn', -32, 0, -10, -31, 5, -6.5);
H('spawn', -32, 0, -2.5, -31, 5, 2.5);
H('spawn', -32, 0, 6.5, -31, 5, 10);
H('spawn', -32, 3.5, -6.5, -31, 5, -2.5);   // 문 위 상인방
H('spawn', -32, 3.5, 2.5, -31, 5, 6.5);
H('spawn', -43, 0, -11, -31, 5, -10);
H('spawn', -43, 0, 10, -31, 5, 11);
H('roof', -43, 5, -11, -31, 5.6, 11);

// 북쪽 고지대 플랫폼 + 계단 + 난간
H('platform', -24, 0, 16, -14, 3, 26);
stairsZ(half, -20, -17, 16, +1, 3);
H('railing', -24, 3, 16, -20, 4, 16.3);
H('railing', -17, 3, 16, -14, 4, 16.3);

// 중앙 차선 엄폐물
H('cover', -22, 0, -4, -20.5, 2.4, 4);
H('crate', -27, 0, 6, -25.6, 1.4, 7.4);
H('crate', -27, 0, 7.4, -25.6, 1.4, 8.8);
H('crate', -26.9, 1.4, 6.7, -25.7, 2.6, 7.9);
H('crate', -13, 0, -5, -11, 1.4, -3.6);
H('crate', -14, 0, 3, -12.6, 1.4, 4.4);
H('pillar', -8.2, 0, -8.2, -6.8, 5, -6.8);
H('pillar', -8.2, 0, 6.8, -6.8, 5, 8.2);
H('cover', -12, 0, 9, -9, 1.2, 10);

// 남쪽 창고(지붕 있는 통로)
H('building', -26, 0, -14.5, -21, 4.5, -14);
H('building', -17, 0, -14.5, -12, 4.5, -14);
H('building', -26, 0, -26, -25.5, 4.5, -22);
H('building', -26, 0, -18, -25.5, 4.5, -14.5);
H('building', -12.5, 0, -26, -12, 4.5, -22);
H('building', -12.5, 0, -18, -12, 4.5, -14.5);
H('roof', -26, 4.5, -26, -12, 5, -14);
H('crate', -24.5, 0, -25, -23.1, 1.4, -23.6);
H('crate', -16, 0, -19, -14.6, 1.4, -17.6);

for (const b of half) {
  boxes.push(b);
  boxes.push({ kind: b.kind, min: [-b.max[0], b.min[1], b.min[2]], max: [-b.min[0], b.max[1], b.max[2]] });
}

// ── 스폰·거점·회복 팩 ─────────────────────────────
const spawns = [[], []];
for (const x of [-39, -36]) {
  for (const z of [-5.5, -3.5, 3.5, 5.5]) { // 스폰룸 문(z ∈ ±[2.5, 6.5]) 정면
    spawns[0].push({ pos: [x, 0, z], yaw: -Math.PI / 2 });   // +x 방향을 바라봄
    spawns[1].push({ pos: [-x, 0, z], yaw: Math.PI / 2 });   // -x 방향을 바라봄
  }
}

const spawnZones = [
  { min: [-43, 0, -10], max: [-31, 5, 10] },
  { min: [31, 0, -10], max: [43, 5, 10] },
];

const healthPacksHalf = [
  { pos: [-19, 0, -20], size: 'large' },
  { pos: [-28.5, 0, 9], size: 'small' },
  { pos: [-10, 0, -11], size: 'small' },
  { pos: [-22, 3, 23], size: 'small' },
];
const healthPacks = [];
for (const h of healthPacksHalf) {
  healthPacks.push(h, { pos: [-h.pos[0], h.pos[1], h.pos[2]], size: h.size });
}

const round = (v) => Math.round(v * 1000) / 1000;
const data = {
  name: '케스트럴 야드',
  version: 1,
  bounds: { min: [-44, -1, -28], max: [44, 14, 28] },
  boxes: boxes.map((b) => ({ kind: b.kind, min: b.min.map(round), max: b.max.map(round) })),
  spawns: spawns.map((s) => s.map((p) => ({ pos: p.pos, yaw: round(p.yaw) }))),
  spawnZones,
  point: { pos: [0, 0.5, 0], radius: 5 },
  healthPacks,
};

// 박스·스폰 하나당 한 줄로 써서 diff 를 읽기 쉽게 한다.
const lines = JSON.stringify({ ...data, boxes: '@B', spawns: '@S', healthPacks: '@H' }, null, 1)
  .replace('"@B"', '[\n  ' + data.boxes.map((b) => JSON.stringify(b)).join(',\n  ') + '\n ]')
  .replace('"@S"', '[\n  ' + data.spawns.map((s) => JSON.stringify(s)).join(',\n  ') + '\n ]')
  .replace('"@H"', '[\n  ' + data.healthPacks.map((h) => JSON.stringify(h)).join(',\n  ') + '\n ]');
const out = fileURLToPath(new URL('../shared/map-data.json', import.meta.url));
writeFileSync(out, lines + '\n');
console.log(`map-data.json: ${data.boxes.length} boxes, ${healthPacks.length} health packs`);
