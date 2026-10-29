// 봇 길찾기용 내비게이션 그리드. 맵 박스 윗면 중 사람이 설 수 있는 지점을 0.5m 간격으로 샘플링한다.
import { collides } from '../shared/physics.js';
import { PHYS } from '../shared/constants.js';

const CELL = 0.5;
const AGENT_R = 0.45;
const AGENT_H = 2.0;
const MAX_DROP = 4;

export class NavGrid {
  constructor(map) {
    this.map = map;
    const [minX, , minZ] = map.bounds.min;
    const [maxX, , maxZ] = map.bounds.max;
    this.minX = minX;
    this.minZ = minZ;
    this.nx = Math.floor((maxX - minX) / CELL);
    this.nz = Math.floor((maxZ - minZ) / CELL);
    this.cells = new Array(this.nx * this.nz); // 셀별 노드 id 배열
    const xs = [], ys = [], zs = [];
    const b = map.b;
    for (let iz = 0; iz < this.nz; iz++) {
      for (let ix = 0; ix < this.nx; ix++) {
        const x = minX + (ix + 0.5) * CELL;
        const z = minZ + (iz + 0.5) * CELL;
        const ids = [];
        const tops = new Set();
        for (let i = 0; i < map.n; i++) {
          const o = i * 6;
          if (x > b[o] && x < b[o + 3] && z > b[o + 2] && z < b[o + 5]) tops.add(b[o + 4]);
        }
        for (const top of tops) {
          // 계단 한 칸 높이 이하의 턱은 올라설 수 있으므로 그 위부터 공간을 확인한다
          if (!collides(map, x, top + PHYS.stepHeight + 0.01, z, AGENT_R, AGENT_H - PHYS.stepHeight)) {
            ids.push(xs.length);
            xs.push(x); ys.push(top); zs.push(z);
          }
        }
        this.cells[iz * this.nx + ix] = ids;
      }
    }
    this.count = xs.length;
    this.x = Float32Array.from(xs);
    this.y = Float32Array.from(ys);
    this.z = Float32Array.from(zs);

    // 이웃 연결(8방향). 오르막은 stepHeight 이하, 내리막은 MAX_DROP 까지.
    this.adj = new Array(this.count);
    for (let iz = 0; iz < this.nz; iz++) {
      for (let ix = 0; ix < this.nx; ix++) {
        for (const a of this.cells[iz * this.nx + ix]) {
          const list = [];
          for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dz) continue;
              const jx = ix + dx, jz = iz + dz;
              if (jx < 0 || jz < 0 || jx >= this.nx || jz >= this.nz) continue;
              for (const c of this.cells[jz * this.nx + jx]) {
                const dy = this.y[c] - this.y[a];
                if (dy > PHYS.stepHeight || dy < -MAX_DROP) continue;
                // 모서리 끊기 방지: 대각선은 양 옆 셀도 통행 가능해야 함
                if (dx && dz) {
                  if (!this.nodeNear(ix + dx, iz, this.y[a], 0.6) || !this.nodeNear(ix, iz + dz, this.y[a], 0.6)) continue;
                }
                const cost = Math.hypot(dx, dz) * CELL + (dy < -1 ? 1.5 : 0);
                list.push(c, cost);
              }
            }
          }
          this.adj[a] = list;
        }
      }
    }
    this.g = new Float32Array(this.count);
    this.from = new Int32Array(this.count);
    this.gen = new Uint32Array(this.count);
    this.closed = new Uint32Array(this.count);
    this.curGen = 0;
  }

  nodeNear(ix, iz, y, tol) {
    if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) return false;
    for (const id of this.cells[iz * this.nx + ix]) if (Math.abs(this.y[id] - y) <= tol) return true;
    return false;
  }

  // 위치에서 가장 가까운 노드(-1: 없음)
  nearest(x, y, z) {
    const cx = Math.floor((x - this.minX) / CELL);
    const cz = Math.floor((z - this.minZ) / CELL);
    let best = -1, bestD = Infinity;
    for (let r = 0; r <= 4 && best < 0; r++) {
      for (let iz = cz - r; iz <= cz + r; iz++) {
        for (let ix = cx - r; ix <= cx + r; ix++) {
          if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) continue;
          if (Math.max(Math.abs(ix - cx), Math.abs(iz - cz)) !== r) continue;
          for (const id of this.cells[iz * this.nx + ix]) {
            const dy = this.y[id] - y;
            if (dy > 1.0 || dy < -2.5) continue;
            const d = Math.hypot(this.x[id] - x, this.z[id] - z) + Math.abs(dy) * 2;
            if (d < bestD) { bestD = d; best = id; }
          }
        }
      }
    }
    return best;
  }

  // A*. 반환: [[x,y,z], ...] (시작 노드 제외) 또는 null
  findPath(sx, sy, sz, tx, ty, tz, maxExpand = 12000) {
    const s = this.nearest(sx, sy, sz);
    const t = this.nearest(tx, ty, tz);
    if (s < 0 || t < 0) return null;
    if (s === t) return [[this.x[t], this.y[t], this.z[t]]];
    const gen = ++this.curGen;
    const heap = new MinHeap();
    const h = (n) => Math.hypot(this.x[n] - this.x[t], this.z[n] - this.z[t]) + Math.abs(this.y[n] - this.y[t]);
    this.gen[s] = gen; this.g[s] = 0; this.from[s] = -1;
    heap.push(s, h(s));
    let expanded = 0;
    while (heap.size) {
      const a = heap.pop();
      if (a === t) break;
      if (this.closed[a] === gen) continue;
      this.closed[a] = gen;
      if (++expanded > maxExpand) return null;
      const list = this.adj[a];
      for (let i = 0; i < list.length; i += 2) {
        const c = list[i];
        const ng = this.g[a] + list[i + 1];
        if (this.gen[c] !== gen || ng < this.g[c]) {
          this.gen[c] = gen; this.g[c] = ng; this.from[c] = a;
          heap.push(c, ng + h(c));
        }
      }
    }
    if (this.gen[t] !== gen) return null;
    const nodes = [];
    for (let n = t; n !== -1 && n !== s; n = this.from[n]) nodes.push(n);
    nodes.reverse();
    return this.smooth(sx, sy, sz, nodes);
  }

  // 직선으로 걸어갈 수 있는 구간은 건너뛰어 지그재그를 줄인다.
  smooth(sx, sy, sz, nodes) {
    const out = [];
    let cx = sx, cy = sy, cz = sz;
    let i = 0;
    while (i < nodes.length) {
      let j = Math.min(nodes.length - 1, i + 16);
      while (j > i && !this.walkable(cx, cy, cz, nodes[j])) j--;
      const n = nodes[j];
      out.push([this.x[n], this.y[n], this.z[n]]);
      cx = this.x[n]; cy = this.y[n]; cz = this.z[n];
      i = j + 1;
    }
    return out;
  }

  walkable(ax, ay, az, n) {
    const bx = this.x[n], by = this.y[n], bz = this.z[n];
    const len = Math.hypot(bx - ax, bz - az);
    const steps = Math.ceil(len / (CELL * 0.5));
    let y = ay;
    for (let k = 1; k <= steps; k++) {
      const f = k / steps;
      const x = ax + (bx - ax) * f, z = az + (bz - az) * f;
      const ix = Math.floor((x - this.minX) / CELL), iz = Math.floor((z - this.minZ) / CELL);
      if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) return false;
      let ok = false;
      for (const id of this.cells[iz * this.nx + ix]) {
        const dy = this.y[id] - y;
        if (dy <= PHYS.stepHeight && dy >= -0.6) { y = this.y[id]; ok = true; break; }
      }
      if (!ok) return false;
    }
    return Math.abs(y - by) < 0.6;
  }
}

class MinHeap {
  constructor() { this.ids = []; this.keys = []; }
  get size() { return this.ids.length; }
  push(id, key) {
    const ids = this.ids, keys = this.keys;
    let i = ids.length;
    ids.push(id); keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      ids[i] = ids[p]; keys[i] = keys[p];
      i = p;
    }
    ids[i] = id; keys[i] = key;
  }
  pop() {
    const ids = this.ids, keys = this.keys;
    const top = ids[0];
    const lastId = ids.pop(), lastKey = keys.pop();
    if (ids.length) {
      let i = 0;
      const n = ids.length;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= lastKey) break;
        ids[i] = ids[c]; keys[i] = keys[c];
        i = c;
      }
      ids[i] = lastId; keys[i] = lastKey;
    }
    return top;
  }
}
