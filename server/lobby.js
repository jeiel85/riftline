// 방 목록과 접속 처리. 전송 계층과 무관해서 Node(WebSocket)와 브라우저(Worker) 양쪽에서 쓴다.
import { Room } from './room.js';
import { DT, NET } from '../shared/constants.js';
import { sanitizeName, sanitizeRoomCode } from '../shared/protocol.js';

export class Lobby {
  constructor({ log = () => {} } = {}) {
    this.rooms = new Map();
    this.log = log;
  }

  roomList() {
    return [...this.rooms.values()].map((r) => ({
      code: r.code,
      humans: r.humans().length,
      players: r.players.size,
      teamSize: r.teamSize,
      phase: r.phase,
    }));
  }

  humanCount() {
    return [...this.rooms.values()].reduce((n, r) => n + r.humans().length, 0);
  }

  // socket: { readyState, send(text), close(code, reason) } — WebSocket 과 같은 모양.
  // 받은 텍스트는 돌려준 message() 로, 연결 종료는 closed() 로 알려 준다.
  connect(socket) {
    const { rooms, log } = this;
    let player = null;
    let room = null;
    let tokens = NET.maxMessagesPerSecond;
    let lastRefill = Date.now();

    const send = (obj) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(obj));
    };
    const fail = (code, message) => {
      send({ t: 'error', code, message });
      socket.close(4000, code);
    };

    const message = (text) => {
      const now = Date.now();
      tokens = Math.min(NET.maxMessagesPerSecond, tokens + ((now - lastRefill) / 1000) * NET.maxMessagesPerSecond);
      lastRefill = now;
      if (tokens < 1) return; // 초과분은 버린다
      tokens -= 1;
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;

      if (msg.t === 'ping') {
        send({ t: 'pong', ct: typeof msg.ct === 'number' ? msg.ct : 0, st: room ? room.time : 0 });
        return;
      }
      if (!player) {
        if (msg.t !== 'join') return;
        const name = sanitizeName(msg.name) || `플레이어${Math.floor(Math.random() * 900 + 100)}`;
        const code = sanitizeRoomCode(msg.room) || 'public';
        room = rooms.get(code);
        if (!room) {
          if (rooms.size >= NET.maxRooms) return fail('rooms_full', '서버의 방이 가득 찼습니다.');
          const teamSize = Number.isInteger(msg.teamSize) ? msg.teamSize : 3;
          room = new Room(code, { teamSize });
          rooms.set(code, room);
          log(`room created: ${code} (teamSize ${room.teamSize})`);
        }
        if (!room.canJoin()) return fail('room_full', '방이 가득 찼습니다.');
        player = room.addHuman(name);
        player.ws = socket;
        send({ t: 'welcome', id: player.id, room: code, team: player.team, teamSize: room.teamSize, serverTime: room.time });
        send(room.rosterMessage());
        log(`join ${code}: ${name} (#${player.id}, team ${player.team})`);
        return;
      }
      try {
        room.handleMessage(player, msg);
      } catch (err) {
        log('message error', err);
      }
    };

    const closed = () => {
      if (player && room) {
        room.removePlayer(player.id);
        log(`leave ${room.code}: ${player.name}`);
      }
      player = null;
    };

    return { message, closed };
  }

  // 고정 스텝 한 번. 사람이 5초 넘게 없는 방은 닫는다.
  tick() {
    for (const [code, room] of this.rooms) {
      try {
        room.update();
      } catch (err) {
        this.log(`room ${code} tick error`, err);
      }
      if (room.humans().length === 0) {
        room.emptySince += DT;
        if (room.emptySince > 5) {
          this.rooms.delete(code);
          this.log(`room closed: ${code}`);
        }
      } else {
        room.emptySince = 0;
      }
    }
  }
}

// 타이머 오차를 누적 시간으로 보정하는 고정 스텝 루프. 멈췄다 깨어나도 0.25초 넘게 몰아서 돌리지 않는다.
export function startFixedLoop(step) {
  let last = performance.now();
  let acc = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    acc += (now - last) / 1000;
    last = now;
    if (acc > 0.25) acc = 0.25;
    while (acc >= DT) {
      acc -= DT;
      step();
    }
  }, 4);
  return () => clearInterval(timer);
}
