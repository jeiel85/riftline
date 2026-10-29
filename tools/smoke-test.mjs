// 실제 서버를 띄우고 WebSocket 클라이언트 둘로 접속·입력·채팅·정적 파일·악성 입력을 확인한다.
// 실행: npm run smoke
import WebSocket from 'ws';
import { createServer } from '../server/index.js';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = createServer({ port: 0, host: '127.0.0.1', log: () => {} });
const { port } = await app.listen();
const base = `http://127.0.0.1:${port}`;

async function get(path) {
  const res = await fetch(base + path);
  return { status: res.status, type: res.headers.get('content-type') || '', body: await res.arrayBuffer() };
}

class Client {
  constructor(label) {
    this.label = label;
    this.msgs = [];
    this.snaps = [];
    this.events = [];
    this.roster = null;
    this.closed = null;
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('close', (code) => { this.closed = code; });
      this.ws.on('message', (data) => {
        const m = JSON.parse(data.toString());
        this.msgs.push(m);
        if (m.t === 's') {
          this.snaps.push({ at: Date.now(), m });
          this.events.push(...m.ev);
        }
        if (m.t === 'roster') this.roster = m.players;
      });
    });
  }
  send(o) { this.ws.send(typeof o === 'string' ? o : JSON.stringify(o)); }
  async waitFor(pred, ms = 3000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = this.msgs.find(pred);
      if (hit) return hit;
      await sleep(10);
    }
    return null;
  }
  get last() { return this.snaps.length ? this.snaps[this.snaps.length - 1].m : null; }
}

try {
  // ── 정적 파일 ──
  const idx = await get('/');
  check('index.html 제공', idx.status === 200 && idx.type.includes('text/html'));
  const three = await get('/vendor/three/build/three.module.js');
  check('three.js 모듈 제공', three.status === 200 && three.type.includes('javascript'));
  const map = await get('/shared/map-data.json');
  check('맵 JSON 제공', map.status === 200 && map.type.includes('application/json'));
  const glb = await get('/assets/hero_vex.glb');
  check('GLB 애셋 제공', glb.status === 200 && glb.type === 'model/gltf-binary' && glb.body.byteLength > 1000);
  const sim = await get('/server/room.js');
  const worker = await get('/local-server.js');
  check('오프라인 모드용 시뮬레이션 모듈 제공', sim.status === 200 && worker.status === 200 && sim.type.includes('javascript'));
  check('서버 진입점은 제공하지 않음', (await get('/server/index.js')).status === 404);
  for (const bad of ['/../package.json', '/%2e%2e/server/index.js', '/shared/..%2f..%2fpackage.json', '/assets/..%5c..%5cpackage.json']) {
    const r = await get(bad);
    check(`경로 탈출 차단 ${bad}`, r.status === 404, `status ${r.status}`);
  }

  // ── 접속·팀 배정 ──
  const a = new Client('A');
  const b = new Client('B');
  await a.open();
  a.send({ t: 'join', name: '알파<script>', room: 'Smoke Room!', teamSize: 1 });
  const wa = await a.waitFor((m) => m.t === 'welcome');
  check('A 입장', !!wa, wa ? `room=${wa.room} team=${wa.team}` : '');
  check('방 코드 정규화', wa && wa.room === 'smokeroom');
  await b.open();
  b.send({ t: 'join', name: '브라보', room: 'smokeroom' });
  const wb = await b.waitFor((m) => m.t === 'welcome');
  check('B 입장, 다른 팀 배정', wb && wb.team !== wa.team, wb ? `team=${wb.team}` : '');
  const nameA = (await b.waitFor((m) => m.t === 'roster' && m.players.some((p) => p.id === wa.id)))?.players.find((p) => p.id === wa.id)?.name;
  check('이름의 꺾쇠 제거', nameA === '알파script', nameA);

  a.send({ t: 'hero', hero: 'rook' });
  b.send({ t: 'hero', hero: 'vex' });
  b.send({ t: 'hero', hero: 'notahero' });
  await sleep(300);
  check('히어로 선택 반영', a.last?.me.hero === 'rook' && a.last?.me.alive === 1 && b.last?.me.hero === 'vex');

  // ── 스냅샷 주기 ──
  const n0 = a.snaps.length;
  await sleep(1000);
  const rate = a.snaps.length - n0;
  check('스냅샷 약 30Hz', rate >= 24 && rate <= 36, `${rate}/s`);

  // ── 입력 → 이동·ack ──
  const x0 = a.last.me.x;
  const yaw = a.last.me.yaw;
  let seq = 0;
  for (let i = 0; i < 60; i++) {
    a.send({ t: 'in', c: [[seq++, 0, 1, yaw, 0, 0, a.last.tm]] });
    await sleep(16);
  }
  await sleep(300);
  const moved = a.last.me.x - x0;
  check('입력으로 이동', moved > 3, `${moved.toFixed(2)}m`);
  check('입력 ack 진행', a.last.ack === seq - 1, `ack=${a.last.ack} last=${seq - 1}`);

  // 같은 seq 재전송·과속 입력은 무시된다
  const xBefore = a.last.me.x;
  const burst = [];
  for (let i = 0; i < 16; i++) burst.push([seq - 1, 0, 1, yaw, 0, 0, 0]);
  a.send({ t: 'in', c: burst });
  await sleep(200);
  check('중복 seq 입력 무시', Math.abs(a.last.me.x - xBefore) < 0.01);

  // ── 채팅 ──
  b.send({ t: 'chat', text: '  안녕\u0000하세요  ' });
  await sleep(200);
  const chat = a.events.find((e) => e[0] === 'chat' && e[1] === wb.id);
  check('채팅 전달·정리', chat && chat[2] === '안녕 하세요', chat ? JSON.stringify(chat[2]) : '');

  // ── 악성·잘못된 메시지 ──
  a.send('not json');
  a.send({ t: 'in', c: 'x' });
  a.send({ t: 'in', c: [[1e9, 'a', null]] });
  a.send({ t: 'hero' });
  a.send({ t: '__proto__' });
  await sleep(200);
  check('잘못된 메시지 후에도 연결 유지', a.ws.readyState === 1);

  const c = new Client('C');
  await c.open();
  c.send('x'.repeat(20 * 1024));
  await sleep(300);
  check('너무 큰 메시지는 연결 종료', c.closed !== null, `close=${c.closed}`);
  check('서버는 계속 동작', a.ws.readyState === 1 && (await get('/healthz')).status === 200);

  // ── 핑 ──
  a.send({ t: 'ping', ct: 123 });
  const pong = await a.waitFor((m) => m.t === 'pong' && m.ct === 123);
  check('핑 응답', !!pong);

  // ── 퇴장 → 봇이 빈자리 채움 ──
  b.ws.close();
  await sleep(600);
  const roster = a.roster || [];
  const bTeam = wb.team;
  const filled = roster.filter((p) => p.team === bTeam);
  check('퇴장 후 봇이 자리를 채움', filled.length === 1 && filled[0].bot === 1, JSON.stringify(filled.map((p) => p.name)));

  const rooms = JSON.parse(Buffer.from((await get('/api/rooms')).body).toString());
  check('방 목록 API', rooms.length === 1 && rooms[0].humans === 1, JSON.stringify(rooms));
  a.ws.close();
} catch (err) {
  check('예외 없이 완료', false, err.stack);
} finally {
  await app.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 통과`);
process.exit(failed.length ? 1 : 0);
