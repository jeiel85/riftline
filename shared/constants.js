// 서버·클라이언트가 공유하는 게임 상수. 단위는 미터·초.

export const TICK_RATE = 60;               // 서버/클라이언트 고정 시뮬레이션 스텝(Hz)
export const DT = 1 / TICK_RATE;
export const SNAPSHOT_EVERY = 2;           // 스냅샷 전송 주기(틱) → 30Hz
export const INTERP_DELAY = 0.1;           // 원격 엔티티 보간 지연(초)
export const MAX_REWIND = 0.25;            // 히트스캔 지연 보상 최대 되감기(초)

export const PHYS = {
  gravity: 20,
  jumpVel: 7.2,
  groundAccel: 70,
  airAccel: 14,
  friction: 11,
  stepHeight: 0.55,
  maxFall: 40,
};

export const TEAM_COUNT = 2;
export const TEAM_NAMES = ['청색 팀', '적색 팀'];
export const TEAM_COLORS = ['#3aa0ff', '#ff4d4d'];
export const MAX_PLAYERS_PER_ROOM = 10;    // 사람 + 봇
export const MAX_BOTS_PER_TEAM = 5;

export const MATCH = {
  warmup: 15,          // 시작 전 준비 시간
  unlockDelay: 0,      // 라이브 시작 후 거점 활성화까지
  captureTime: 8,      // 중립/적 거점을 빼앗는 데 걸리는 시간(1인 기준)
  scoreRate: 1 / 1.1,  // 거점 보유 시 초당 퍼센트
  winScore: 100,
  endDuration: 10,
  respawnTime: 5,
  spawnHealRate: 150,  // 스폰룸 초당 회복량
};

export const ULT_PASSIVE_RATE = 4;         // 초당 궁극기 충전 포인트

export const NET = {
  maxMessageBytes: 16 * 1024,
  maxMessagesPerSecond: 240,
  maxCmdsPerMessage: 16,
  maxQueuedCmds: 30,
  nameMaxLen: 14,
  roomCodeMaxLen: 16,
  chatMaxLen: 120,
  chatPerSecond: 2,
  maxRooms: 50,
};

// 입력 버튼 비트마스크
export const BTN = {
  FIRE: 1,
  ALT: 2,
  JUMP: 4,
  SHIFT: 8,
  E: 16,
  Q: 32,
  RELOAD: 64,
};
