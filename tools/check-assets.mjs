// assets/models/*.glb 가 docs/ASSETS.md 규격을 지키는지 검사한다.
// GLB 의 JSON 청크만 읽어 노드 계층·머티리얼·바운딩·삼각형 수를 확인한다(정점 데이터는 읽지 않음).
// 사용: node tools/check-assets.mjs   (실패 항목이 있으면 종료 코드 1)
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { HEROES, HERO_IDS } from '../shared/heroes.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const modelDir = path.join(root, 'assets', 'models');
const mapData = JSON.parse(readFileSync(path.join(root, 'shared', 'map-data.json'), 'utf8'));

const failures = [];
const rows = [];
const fail = (file, msg) => failures.push(`${file}: ${msg}`);

// ── GLB 파싱 ───────────────────────────────────────────
function readGlb(file) {
  const buf = readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('GLB 매직 넘버가 아님');
  const jsonLen = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== 0x4e4f534a) throw new Error('첫 청크가 JSON 이 아님');
  return { json: JSON.parse(buf.toString('utf8', 20, 20 + jsonLen)), size: buf.length };
}

function mat4FromTRS(t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) {
  const [x, y, z, w] = q;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  // 열 우선(column-major), glTF 와 같은 배치
  return [
    (1 - 2 * (yy + zz)) * s[0], 2 * (xy + wz) * s[0], 2 * (xz - wy) * s[0], 0,
    2 * (xy - wz) * s[1], (1 - 2 * (xx + zz)) * s[1], 2 * (yz + wx) * s[1], 0,
    2 * (xz + wy) * s[2], 2 * (yz - wx) * s[2], (1 - 2 * (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
const apply = (m, p) => [0, 1, 2].map((i) => m[i] * p[0] + m[4 + i] * p[1] + m[8 + i] * p[2] + m[12 + i]);

function analyze(json) {
  const nodes = json.nodes ?? [];
  const parent = new Map();
  nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parent.set(c, i)));
  const world = new Map();
  const worldOf = (i) => {
    if (world.has(i)) return world.get(i);
    const n = nodes[i];
    const local = n.matrix ?? mat4FromTRS(n.translation, n.rotation, n.scale);
    const m = parent.has(i) ? mul(worldOf(parent.get(i)), local) : local;
    world.set(i, m);
    return m;
  };
  const byName = new Map(nodes.map((n, i) => [n.name, i]));
  const bboxOf = (i) => {
    const n = nodes[i];
    if (n.mesh === undefined) return null;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const prim of json.meshes[n.mesh].primitives) {
      const acc = json.accessors[prim.attributes.POSITION];
      for (let k = 0; k < 8; k++) {
        const p = [0, 1, 2].map((a) => ((k >> a) & 1 ? acc.max[a] : acc.min[a]));
        const w = apply(worldOf(i), p);
        for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], w[a]); hi[a] = Math.max(hi[a], w[a]); }
      }
    }
    return { lo, hi };
  };
  let tris = 0;
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives) {
      const mode = prim.mode ?? 4;
      if (mode !== 4) continue;
      const count = prim.indices !== undefined ? json.accessors[prim.indices].count : json.accessors[prim.attributes.POSITION].count;
      tris += count / 3;
    }
  }
  const total = { lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] };
  nodes.forEach((_, i) => {
    const b = bboxOf(i);
    if (!b) return;
    for (let a = 0; a < 3; a++) { total.lo[a] = Math.min(total.lo[a], b.lo[a]); total.hi[a] = Math.max(total.hi[a], b.hi[a]); }
  });
  const parentName = (name) => {
    const i = byName.get(name);
    return i === undefined || !parent.has(i) ? null : nodes[parent.get(i)].name;
  };
  const pos = (name) => apply(worldOf(byName.get(name)), [0, 0, 0]);
  const materials = (json.materials ?? []).map((m) => m.name);
  return { nodes, byName, parentName, pos, bboxOf, total, tris, materials };
}

function load(file) {
  const full = path.join(modelDir, file);
  if (!existsSync(full)) {
    fail(file, '파일 없음');
    return null;
  }
  const { json, size } = readGlb(full);
  const a = analyze(json);
  rows.push({ file, kb: (size / 1024).toFixed(1), tris: a.tris, nodes: a.nodes.length });
  return { ...a, json };
}

const srgbToLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const hexLin = (h) => [1, 3, 5].map((i) => srgbToLin(parseInt(h.slice(i, i + 2), 16) / 255));
const near = (a, b, eps) => Math.abs(a - b) <= eps;

// ── 히어로 ──────────────────────────────────────────────
const HIER = { hips: 'root', legL: 'hips', legR: 'hips', torso: 'hips', head: 'torso', armL: 'torso', armR: 'torso', weapon: 'torso', muzzle: 'weapon' };
for (const id of HERO_IDS) {
  const file = `hero_${id}.glb`;
  const g = load(file);
  if (!g) continue;
  const hero = HEROES[id];
  if (!g.byName.has('root')) fail(file, 'root 노드 없음');
  else if (g.parentName('root') !== null) fail(file, 'root 가 최상위가 아님');
  for (const [child, par] of Object.entries(HIER)) {
    if (!g.byName.has(child)) fail(file, `노드 ${child} 없음`);
    else if (g.parentName(child) !== par) fail(file, `${child} 의 부모가 ${g.parentName(child)} (기대: ${par})`);
  }
  if (!g.materials.includes('Team')) fail(file, 'Team 머티리얼 없음');
  const h = g.total.hi[1];
  if (!near(g.total.lo[1], 0, 0.03)) fail(file, `발 높이 ${g.total.lo[1].toFixed(3)} (기대 0)`);
  if (Math.abs(h - hero.height) / hero.height > 0.05) fail(file, `높이 ${h.toFixed(3)} (heroes.js ${hero.height}, ±5% 초과)`);
  if (g.byName.has('muzzle') && g.byName.has('weapon')) {
    const mz = g.pos('muzzle'), wp = g.pos('weapon');
    if (!(mz[2] < wp[2] - 0.2)) fail(file, `총구가 앞(-Z)을 향하지 않음 (muzzle z=${mz[2].toFixed(2)}, weapon z=${wp[2].toFixed(2)})`);
  }
  for (const [n, sign] of [['legL', -1], ['legR', 1], ['armL', -1], ['armR', 1]]) {
    if (g.byName.has(n) && Math.sign(g.pos(n)[0]) !== sign) fail(file, `${n} 이 ${sign < 0 ? '-X' : '+X'} 쪽이 아님`);
  }
  const primary = g.json.materials?.find((m) => m.name === 'Primary');
  const want = hexLin(hero.colors.primary);
  const got = primary?.pbrMetallicRoughness?.baseColorFactor;
  if (!got || want.some((v, i) => !near(v, got[i], 0.01))) fail(file, `Primary 색이 heroes.js(${hero.colors.primary})와 다름`);
  if (g.tris > 5000) fail(file, `삼각형 ${g.tris} > 5000`);
  const w = g.total.hi[0] - g.total.lo[0];
  rows.at(-1).note = `높이 ${h.toFixed(2)}/${hero.height} 폭 ${w.toFixed(2)}`;
}

// ── 1인칭 무기 ──────────────────────────────────────────
for (const id of HERO_IDS) {
  const file = `weapon_${id}.glb`;
  const g = load(file);
  if (!g) continue;
  if (!g.byName.has('weapon') || g.parentName('weapon') !== null) fail(file, '최상위 weapon 노드 없음');
  if (!g.byName.has('muzzle') || g.parentName('muzzle') !== 'weapon') fail(file, 'weapon 아래 muzzle 없음');
  else if (!(g.pos('muzzle')[2] < -0.2)) fail(file, '총구가 -Z 방향이 아님');
  if (g.tris > 3000) fail(file, `삼각형 ${g.tris} > 3000`);
}

// ── 맵 ──────────────────────────────────────────────────
{
  const file = 'map_kestrel.glb';
  const g = load(file);
  if (g) {
    const kinds = new Map();
    for (const b of mapData.boxes) {
      const k = kinds.get(b.kind) ?? { lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] };
      for (let a = 0; a < 3; a++) { k.lo[a] = Math.min(k.lo[a], b.min[a]); k.hi[a] = Math.max(k.hi[a], b.max[a]); }
      kinds.set(b.kind, k);
    }
    const all = { lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] };
    for (const [kind, want] of kinds) {
      const i = g.byName.get(`map_${kind}`);
      if (i === undefined) { fail(file, `map_${kind} 노드 없음`); continue; }
      const b = g.bboxOf(i);
      for (let a = 0; a < 3; a++) {
        if (!near(b.lo[a], want.lo[a], 0.02) || !near(b.hi[a], want.hi[a], 0.02)) {
          fail(file, `map_${kind} 바운딩 ${JSON.stringify(b)} ≠ map-data ${JSON.stringify(want)}`);
          break;
        }
      }
      for (let a = 0; a < 3; a++) { all.lo[a] = Math.min(all.lo[a], b.lo[a]); all.hi[a] = Math.max(all.hi[a], b.hi[a]); }
    }
    const bounds = mapData.bounds;
    for (let a = 0; a < 3; a++) {
      if (all.lo[a] < bounds.min[a] - 0.02 || all.hi[a] > bounds.max[a] + 0.02) fail(file, `충돌 메시가 map-data bounds 밖 (축 ${a})`);
    }
    if (!near(all.lo[0], bounds.min[0], 0.02) || !near(all.hi[0], bounds.max[0], 0.02)
      || !near(all.lo[2], bounds.min[2], 0.02) || !near(all.hi[2], bounds.max[2], 0.02)) {
      fail(file, `충돌 메시 수평 범위 ${JSON.stringify(all)} 가 bounds 와 다름`);
    }
    // 장식: 바깥 원경은 아레나 내부와 겹치면 안 되고, 표면 장식은 얇아야 한다.
    const inner = { lo: [-43, 0, -26], hi: [43, 9, 26] };
    for (const [name, i] of g.byName) {
      if (name.startsWith('map_')) continue;
      const b = g.bboxOf(i);
      if (!b) continue;
      if (name.startsWith('decor_out_')) {
        const overlap = [0, 1, 2].every((a) => b.lo[a] < inner.hi[a] - 0.01 && b.hi[a] > inner.lo[a] + 0.01);
        if (overlap) fail(file, `${name} 가 플레이 공간과 겹침`);
      } else if (name.startsWith('decor_surf_')) {
        const minExt = Math.min(...[0, 1, 2].map((a) => b.hi[a] - b.lo[a]));
        if (minExt > 0.16) fail(file, `${name} 두께 ${minExt.toFixed(3)} > 0.16`);
      } else {
        fail(file, `규칙에 없는 노드 이름 ${name}`);
      }
    }
    if (g.tris > 60000) fail(file, `삼각형 ${g.tris} > 60000`);
    rows.at(-1).note = `kinds ${kinds.size}, 장식 노드 ${[...g.byName.keys()].filter((n) => n.startsWith('decor_')).length}`;
  }
}

// ── 소품 ────────────────────────────────────────────────
const PROPS = {
  'prop_mine.glb': ['mine'],
  'prop_turret.glb': ['turret', 'head', 'muzzle'],
  'prop_canister.glb': ['canister'],
  'prop_healthpack_small.glb': ['healthpack'],
  'prop_healthpack_large.glb': ['healthpack'],
};
for (const [file, names] of Object.entries(PROPS)) {
  const g = load(file);
  if (!g) continue;
  for (const n of names) if (!g.byName.has(n)) fail(file, `노드 ${n} 없음`);
  if (file === 'prop_turret.glb') {
    if (!g.materials.includes('Team')) fail(file, 'Team 머티리얼 없음');
    if (g.parentName('muzzle') !== 'head') fail(file, 'muzzle 이 head 의 자식이 아님');
    else if (!(g.pos('muzzle')[2] < g.pos('head')[2])) fail(file, '총구가 -Z 방향이 아님');
  }
  if (file === 'prop_mine.glb' && !g.materials.includes('Glow')) fail(file, 'Glow 머티리얼 없음');
  if (g.tris > 3000) fail(file, `삼각형 ${g.tris} > 3000`);
}

console.table(rows);
if (failures.length) {
  console.error(`\n실패 ${failures.length}건:`);
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
console.log(`\n모든 애셋 검사 통과 (${rows.length}개 파일)`);
