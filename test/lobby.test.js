// 전송 계층과 무관한 Lobby: Node WebSocket 과 브라우저 Worker(오프라인 모드)가 같은 경로를 쓴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../server/lobby.js';

function fakeSocket() {
  const sock = {
    readyState: 1,
    sent: [],
    closedWith: null,
    send(text) {
      sock.sent.push(JSON.parse(text));
    },
    close(code, reason) {
      sock.readyState = 3;
      sock.closedWith = { code, reason };
    },
  };
  return sock;
}

test('lobby: join → welcome·roster, 스냅샷 송신, 퇴장 시 정리', () => {
  const lobby = new Lobby();
  const sock = fakeSocket();
  const s = lobby.connect(sock);
  s.message(JSON.stringify({ t: 'ping', ct: 5 }));
  assert.equal(sock.sent[0].t, 'pong');
  assert.equal(sock.sent[0].ct, 5);

  s.message(JSON.stringify({ t: 'join', name: '테스터', room: '오프라인', teamSize: 2 }));
  const welcome = sock.sent.find((m) => m.t === 'welcome');
  assert.ok(welcome, 'welcome 수신');
  assert.equal(welcome.room, '오프라인');
  assert.ok(sock.sent.some((m) => m.t === 'roster'));
  const room = lobby.rooms.get('오프라인');
  assert.equal(room.players.size, 4, '2v2 를 봇으로 채움');

  s.message(JSON.stringify({ t: 'hero', hero: 'vex' }));
  for (let i = 0; i < 10; i++) lobby.tick();
  assert.ok(sock.sent.some((m) => m.t === 's'), '틱마다 스냅샷 송신');

  s.message('not json');
  s.message(JSON.stringify({ t: 'in', c: 'bad' }));
  lobby.tick();
  assert.equal(lobby.humanCount(), 1, '잘못된 메시지에도 연결 유지');

  s.closed();
  assert.equal(lobby.humanCount(), 0);
  for (let i = 0; i < 60 * 5 + 2; i++) lobby.tick();
  assert.equal(lobby.rooms.size, 0, '빈 방은 5초 뒤 닫힘');
});

test('lobby: 방이 가득 차면 error 후 close', () => {
  const lobby = new Lobby();
  const socks = [];
  for (let i = 0; i < 11; i++) {
    const sock = fakeSocket();
    socks.push(sock);
    lobby.connect(sock).message(JSON.stringify({ t: 'join', name: `p${i}`, room: 'full', teamSize: 0 }));
  }
  const last = socks[10];
  assert.equal(last.sent[0].t, 'error');
  assert.equal(last.sent[0].code, 'room_full');
  assert.equal(last.closedWith.code, 4000);
});
