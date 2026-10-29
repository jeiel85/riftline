import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../server/room.js';
import { HEROES } from '../shared/heroes.js';
import { BTN, DT, MATCH } from '../shared/constants.js';
import { createMoveState } from '../shared/physics.js';
import { parseCmd } from '../shared/protocol.js';

const EAST = -Math.PI / 2;
const WEST = Math.PI / 2;

function makeRoom() {
  return new Room('t', { teamSize: 0, rng: () => 0.5 });
}

// 열린 공간(북쪽 차선 가운데, y=0)에 두 플레이어를 마주 보게 둔다.
function duel(room, heroA, heroB, dist = 10) {
  const a = room.addHuman('A');
  const b = room.addHuman('B');
  room.setHero(a, heroA);
  room.setHero(b, heroB);
  a.move = createMoveState([-dist / 2, 0, 12]);
  b.move = createMoveState([dist / 2, 0, 12]);
  a.move.onGround = b.move.onGround = true;
  a.yaw = EAST;
  b.yaw = WEST;
  return [a, b];
}

let seq = 0;
function cmd(p, buttons, { yaw = p.yaw, pitch = 0, rt } = {}) {
  p.queue.push({ seq: seq++, mx: 0, mz: 0, yaw, pitch, buttons, rt: rt ?? p.room?.time ?? 0 });
}

function ticks(room, n) {
  for (let i = 0; i < n; i++) room.update();
}

test('팀 자동 배정과 봇 채우기', () => {
  const r = new Room('t', { teamSize: 3 });
  const a = r.addHuman('A');
  const counts = r.teamCounts();
  assert.deepEqual(counts, [3, 3]);
  assert.equal(a.team, 0);
  const b = r.addHuman('B');
  assert.equal(b.team, 1);
  assert.deepEqual(r.teamCounts(), [3, 3]);
  assert.equal([...r.players.values()].filter((p) => p.isBot).length, 4);
});

test('히트스캔 몸통·머리 피해', () => {
  const r = makeRoom();
  const [a, b] = duel(r, 'vex', 'kodiak');
  // 몸통
  const pitchBody = Math.atan2(1.0 - HEROES.vex.eye, 10);
  cmd(a, BTN.FIRE, { pitch: pitchBody, rt: r.time });
  ticks(r, 1);
  assert.equal(b.hp, HEROES.kodiak.hp - HEROES.vex.weapon.damage);
  // 머리(쿨다운 대기 후)
  ticks(r, 10);
  const hy = HEROES.kodiak.height - HEROES.kodiak.headRadius;
  cmd(a, BTN.FIRE, { pitch: Math.atan2(hy - HEROES.vex.eye, 10), rt: r.time });
  ticks(r, 1);
  assert.equal(b.hp, HEROES.kodiak.hp - HEROES.vex.weapon.damage * 3);
  assert.equal(a.ammo, HEROES.vex.weapon.mag - 2);
});

test('아군 사격은 피해가 없다', () => {
  const r = makeRoom();
  const [a, b] = duel(r, 'vex', 'kodiak');
  b.team = a.team;
  cmd(a, BTN.FIRE, { pitch: Math.atan2(1.0 - HEROES.vex.eye, 10), rt: r.time });
  ticks(r, 1);
  assert.equal(b.hp, HEROES.kodiak.hp);
});

test('지연 보상: 과거 위치를 맞히면 판정된다', () => {
  const r = makeRoom();
  const [a, b] = duel(r, 'rook', 'vex');
  ticks(r, 10);
  const past = r.time;
  // b 가 옆으로 2m 비켜선다
  b.move.z = 14;
  ticks(r, 6);
  const pitch = Math.atan2(1.0 - HEROES.rook.eye, 10);
  cmd(a, BTN.FIRE, { pitch, rt: past });
  ticks(r, 1);
  assert.equal(b.hp, HEROES.vex.hp - HEROES.rook.weapon.damage);
});

test('플라즈마 직격 + 처치 + 부활', () => {
  const r = makeRoom();
  const [a, b] = duel(r, 'ember', 'rook', 8);
  const pitch = Math.atan2(1.0 - HEROES.ember.eye, 8);
  cmd(a, BTN.FIRE, { pitch, rt: r.time });
  ticks(r, 30);
  assert.equal(b.hp, HEROES.rook.hp - HEROES.ember.weapon.damage);
  for (let i = 0; i < 3; i++) {
    ticks(r, 60);
    cmd(a, BTN.FIRE, { pitch, rt: r.time });
  }
  ticks(r, 30);
  assert.equal(b.alive, false);
  assert.equal(a.kills, 1);
  assert.equal(b.deaths, 1);
  ticks(r, Math.ceil(MATCH.respawnTime / DT) + 2);
  assert.equal(b.alive, true);
  assert.equal(b.hp, HEROES.rook.hp);
  assert.ok(b.move.x > 30, '적색 팀 스폰에서 부활');
});

test('솔 구슬은 다친 아군을 치유한다', () => {
  const r = makeRoom();
  const [a, b] = duel(r, 'sol', 'kodiak', 6);
  b.team = a.team;
  b.hp = 100;
  cmd(a, BTN.FIRE, { pitch: Math.atan2(1.0 - HEROES.sol.eye, 6), rt: r.time });
  ticks(r, 20);
  assert.equal(b.hp, 100 + HEROES.sol.weapon.heal);
  assert.ok(a.healingDone >= HEROES.sol.weapon.heal);
});

test('방벽 장갑은 받는 피해를 줄인다', () => {
  const r = makeRoom();
  const [a, b] = duel(r, 'vex', 'kodiak');
  cmd(b, BTN.E);
  ticks(r, 1);
  assert.ok(b.status.fortify > 0);
  cmd(a, BTN.FIRE, { pitch: Math.atan2(1.0 - HEROES.vex.eye, 10), rt: r.time });
  ticks(r, 1);
  assert.equal(b.hp, HEROES.kodiak.hp - HEROES.vex.weapon.damage * 0.5);
});

test('궁극기는 게이지가 차야 쓸 수 있다', () => {
  const r = makeRoom();
  const [a] = duel(r, 'vex', 'kodiak');
  cmd(a, BTN.Q);
  ticks(r, 1);
  assert.equal(a.status.overdrive, 0);
  a.ult = HEROES.vex.ultCost;
  cmd(a, BTN.Q);
  ticks(r, 1);
  assert.ok(a.status.overdrive > 0);
  assert.ok(a.ult < 10);
});

test('거점 점령과 점수 누적, 승리', () => {
  const r = makeRoom();
  const a = r.addHuman('A');
  r.setHero(a, 'vex');
  r.startLive();
  a.move = createMoveState([0, 0.5, 0]);
  a.move.onGround = true;
  ticks(r, Math.ceil(MATCH.captureTime / DT) + 5);
  assert.equal(r.point.owner, a.team);
  ticks(r, 60 * 5);
  assert.ok(r.point.scores[a.team] > 4);
  r.point.scores[a.team] = 99.9;
  ticks(r, 10);
  assert.equal(r.phase, 'end');
  assert.equal(r.winner, a.team);
});

test('스폰룸 밖에서는 히어로 변경이 다음 부활로 미뤄진다', () => {
  const r = makeRoom();
  const a = r.addHuman('A');
  r.setHero(a, 'vex');
  r.setHero(a, 'sol');
  assert.equal(a.hero, 'sol', '스폰룸 안에서는 즉시 변경');
  a.move.x = 0;
  r.setHero(a, 'rook');
  assert.equal(a.hero, 'sol');
  assert.equal(a.pendingHero, 'rook');
});

test('잘못된 입력 명령은 버린다', () => {
  assert.equal(parseCmd(null), null);
  assert.equal(parseCmd([1, 'x', 0, 0, 0, 0, 0]), null);
  assert.equal(parseCmd([-1, 0, 0, 0, 0, 0, 0]), null);
  assert.equal(parseCmd([1, 0, 0, NaN, 0, 0, 0]), null);
  const c = parseCmd([5, 9, -9, 1, 3, 1, 0]);
  assert.equal(c.mx, 1);
  assert.equal(c.mz, -1);
  assert.equal(c.pitch, 1.5);
});

test('봇 5대5 경기가 오류 없이 진행된다', () => {
  const r = new Room('bots', { teamSize: 5 });
  r.balanceBots();
  ticks(r, 60 * 60);
  const kills = [...r.players.values()].reduce((n, p) => n + p.kills, 0);
  assert.ok(kills > 0, '교전이 일어난다');
  assert.ok(r.point.owner >= 0 || r.point.cap > 0, '거점 점령을 시도한다');
});
