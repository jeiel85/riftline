import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMoveState, stepMove } from '../shared/physics.js';
import { rayBox, raycastMap, rayPlayer } from '../shared/raycast.js';
import { MAP, compileMap } from '../shared/map.js';
import { HEROES } from '../shared/heroes.js';
import { DT, BTN, PHYS } from '../shared/constants.js';

const vex = HEROES.vex;
const idle = (yaw = 0, buttons = 0) => ({ mx: 0, mz: 0, yaw, pitch: 0, buttons });
const fwd = (yaw, buttons = 0) => ({ mx: 0, mz: 1, yaw, pitch: 0, buttons });
const EAST = -Math.PI / 2; // +x 방향

function run(st, cmd, hero, map, n) {
  for (let i = 0; i < n; i++) stepMove(st, typeof cmd === 'function' ? cmd(i) : cmd, hero, null, map, DT);
  return st;
}

test('떨어지면 바닥에 착지한다', () => {
  const st = run(createMoveState([0, 5, 15]), idle(), vex, MAP, 120);
  assert.equal(st.y, 0);
  assert.ok(st.onGround);
});

test('벽에 막히면 벽면에서 멈춘다', () => {
  // 서쪽 외벽은 x ∈ [-44,-43]
  const st = createMoveState([-40, 0, 15]);
  st.onGround = true;
  run(st, fwd(Math.PI / 2), vex, MAP, 120); // -x 방향
  assert.ok(Math.abs(st.x - (-43 + vex.radius)) < 0.01, `x=${st.x}`);
});

test('0.5m 거점 단은 걸어서 올라선다', () => {
  const st = createMoveState([-8.5, 0, 0]);
  st.onGround = true;
  run(st, fwd(EAST), vex, MAP, 60);
  assert.equal(st.y, 0.5);
  assert.ok(st.x > -5);
});

test('1.4m 상자는 걸어서 못 넘는다', () => {
  // 상자 x ∈ [-13,-11], z ∈ [-5,-3.6]
  const st = createMoveState([-16, 0, -4.3]);
  st.onGround = true;
  run(st, fwd(EAST), vex, MAP, 120);
  assert.equal(st.y, 0);
  assert.ok(st.x <= -13 - vex.radius + 0.01, `x=${st.x}`);
});

test('계단으로 3m 고지대에 오른다', () => {
  // 계단 x ∈ [-20,-17], 북쪽(+z)으로 올라가 z=16 에서 고지대(y=3)
  const st = createMoveState([-18.5, 0, 11]);
  st.onGround = true;
  run(st, fwd(Math.PI), vex, MAP, 150); // +z 방향
  assert.equal(st.y, 3);
  assert.ok(st.z > 16);
});

test('점프 높이는 v²/2g 근처', () => {
  const st = createMoveState([0, 0, 15]);
  st.onGround = true;
  let maxY = 0;
  run(st, (i) => idle(0, i === 0 ? BTN.JUMP : 0), vex, MAP, 90);
  const st2 = createMoveState([0, 0, 15]);
  st2.onGround = true;
  for (let i = 0; i < 90; i++) {
    stepMove(st2, idle(0, i === 0 ? BTN.JUMP : 0), vex, null, MAP, DT);
    maxY = Math.max(maxY, st2.y);
  }
  const expect = (PHYS.jumpVel * PHYS.jumpVel) / (2 * PHYS.gravity);
  assert.ok(Math.abs(maxY - expect) < 0.15, `maxY=${maxY}`);
  assert.equal(st.y, 0);
});

test('이동기(대시)는 쿨다운 동안 다시 쓰이지 않는다', () => {
  const st = createMoveState([0, 0, 15]);
  st.onGround = true;
  const x0 = st.x;
  run(st, idle(EAST, BTN.SHIFT), vex, MAP, 30);
  const dist = st.x - x0;
  const expected = vex.shift.speed * vex.shift.duration;
  assert.ok(dist > expected * 0.9 && dist < expected * 1.3, `dash=${dist}`);
  assert.equal(st.dashSeq, 1);
  assert.ok(st.cdShift > 0);
});

test('같은 입력이면 같은 결과(예측 결정성)', () => {
  const cmds = Array.from({ length: 200 }, (_, i) => ({ mx: Math.sin(i * 0.1), mz: 1, yaw: i * 0.02, pitch: 0, buttons: i % 37 === 0 ? BTN.JUMP : i === 50 ? BTN.SHIFT : 0 }));
  const a = createMoveState([-30, 0, 0]);
  const b = createMoveState([-30, 0, 0]);
  for (const c of cmds) stepMove(a, c, vex, null, MAP, DT);
  for (const c of cmds) stepMove(b, c, vex, null, MAP, DT);
  assert.deepEqual(a, b);
});

test('광선-박스와 맵 광선', () => {
  assert.equal(rayBox(0, 0, 0, 1, 0, 0, 2, -1, -1, 3, 1, 1, 10), 2);
  assert.equal(rayBox(0, 0, 0, -1, 0, 0, 2, -1, -1, 3, 1, 1, 10), -1);
  const m = compileMap({ boxes: [{ kind: 'x', min: [5, 0, -1], max: [6, 2, 1] }] });
  const hit = raycastMap(m, 0, 1, 0, 1, 0, 0, 20);
  assert.equal(hit.t, 5);
  assert.deepEqual([hit.nx, hit.ny, hit.nz], [-1, 0, 0]);
});

test('머리와 몸통 판정', () => {
  const h = HEROES.vex;
  const head = rayPlayer(0, h.height - h.headRadius, 10, 0, 0, -1, 0, 0, 0, h, 50);
  assert.ok(head && head.head);
  const body = rayPlayer(0, 1.0, 10, 0, 0, -1, 0, 0, 0, h, 50);
  assert.ok(body && !body.head);
  const miss = rayPlayer(2, 1.0, 10, 0, 0, -1, 0, 0, 0, h, 50);
  assert.equal(miss, null);
});
