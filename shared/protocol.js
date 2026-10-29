// 네트워크 메시지 형식과 입력 검증. 모든 메시지는 JSON 객체이며 t 필드로 종류를 구분한다.
//
// 클라이언트 → 서버
//   join  { t, name, room, teamSize }          방 입장(없으면 생성)
//   hero  { t, hero }                           히어로 선택/변경
//   team  { t }                                 팀 변경 요청
//   in    { t, c: [[seq, mx, mz, yaw, pitch, buttons, rt], ...] }   입력 명령 묶음
//   chat  { t, text }
//   ping  { t, ct }
//
// 서버 → 클라이언트
//   welcome { t, id, room, team, teamSize, serverTime }
//   roster  { t, players: [{ id, name, team, hero, k, d, bot }] }
//   s       스냅샷(서버 room.js 의 buildSnapshot 참고)
//   pong    { t, ct, st }
//   error   { t, code, message }
import { NET } from './constants.js';

export function sanitizeName(raw) {
  if (typeof raw !== 'string') return '';
  // 제어 문자 제거, 앞뒤 공백 정리
  const s = raw.replace(/[\u0000-\u001f\u007f<>]/g, '').trim();
  return Array.from(s).slice(0, NET.nameMaxLen).join('');
}

export function sanitizeRoomCode(raw) {
  if (typeof raw !== 'string') return '';
  return raw.toLowerCase().replace(/[^a-z0-9가-힣_-]/g, '').slice(0, NET.roomCodeMaxLen);
}

export function sanitizeChat(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return Array.from(s).slice(0, NET.chatMaxLen).join('');
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// 입력 명령 하나를 검증·정규화. 잘못되면 null.
export function parseCmd(arr) {
  if (!Array.isArray(arr) || arr.length < 7) return null;
  const seq = arr[0];
  if (!Number.isInteger(seq) || seq < 0) return null;
  const mx = num(arr[1]), mz = num(arr[2]), yaw = num(arr[3]), pitch = num(arr[4]), rt = num(arr[6]);
  const buttons = arr[5];
  if (mx === null || mz === null || yaw === null || pitch === null || rt === null) return null;
  if (!Number.isInteger(buttons) || buttons < 0 || buttons > 0xffff) return null;
  return {
    seq,
    mx: clamp(mx, -1, 1),
    mz: clamp(mz, -1, 1),
    yaw: ((yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2),
    pitch: clamp(pitch, -1.5, 1.5),
    buttons,
    rt,
  };
}
