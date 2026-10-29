// 오프라인(봇전) 모드: 서버 시뮬레이션을 브라우저 Worker 안에서 그대로 돌린다.
// 메인 스레드와는 WebSocket 과 같은 텍스트 메시지를 주고받고, 제어 신호만 객체로 보낸다.
// 경로는 URL 기준이다(서버 MOUNTS·GitHub Pages 빌드 모두 /server/, /shared/ 를 페이지 옆에 둔다).
import { Lobby, startFixedLoop } from './server/lobby.js';

const lobby = new Lobby({ log: (...args) => console.debug('[local]', ...args) });

const socket = {
  readyState: 1,
  send(text) {
    postMessage(text);
  },
  close(code, reason) {
    if (socket.readyState !== 1) return;
    socket.readyState = 3;
    postMessage({ ctl: 'close', code, reason });
  },
};
const session = lobby.connect(socket);

self.onmessage = (ev) => {
  if (typeof ev.data === 'string') session.message(ev.data);
};

startFixedLoop(() => lobby.tick());
postMessage({ ctl: 'open' });
