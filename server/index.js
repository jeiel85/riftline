// HTTP(정적 파일) + WebSocket 게임 서버.
// 실행: npm start  (환경 변수 PORT, HOST)
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Lobby, startFixedLoop } from './lobby.js';
import { NET } from '../shared/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 브라우저 오프라인 모드(Worker)가 그대로 불러 쓰는 서버 시뮬레이션 모듈. 서버 진입점(index.js)은 내보내지 않는다.
export const SIM_MODULES = ['lobby.js', 'room.js', 'bot.js', 'nav.js'];

// URL 접두사 → 디스크 디렉터리(세 번째 값이 있으면 그 파일만). 이 밖의 경로는 제공하지 않는다.
const MOUNTS = [
  ['/vendor/three/', path.join(ROOT, 'node_modules/three/')],
  ['/shared/', path.join(ROOT, 'shared/')],
  ['/server/', path.join(ROOT, 'server/'), new Set(SIM_MODULES)],
  ['/assets/', path.join(ROOT, 'assets/models/')],
  ['/', path.join(ROOT, 'client/')],
];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export function createServer({ port = 8080, host = '0.0.0.0', log = console.log } = {}) {
  const lobby = new Lobby({ log });
  const rooms = lobby.rooms;

  async function serveStatic(req, res) {
    const url = new URL(req.url, 'http://localhost');
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    if (pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, rooms: rooms.size, humans: lobby.humanCount() }));
      return;
    }
    if (pathname === '/api/rooms') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(lobby.roomList()));
      return;
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    for (const [prefix, dir, only] of MOUNTS) {
      if (!pathname.startsWith(prefix)) continue;
      const file = path.resolve(dir, '.' + pathname.slice(prefix.length - 1));
      if (!file.startsWith(dir)) break; // 경로 탈출 차단
      if (only && !only.has(path.relative(dir, file))) break;
      try {
        const st = await stat(file);
        if (!st.isFile()) break;
        const body = await readFile(file);
        res.writeHead(200, {
          'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'cache-control': prefix === '/vendor/three/' ? 'public, max-age=86400' : 'no-cache',
          'x-content-type-options': 'nosniff',
        });
        res.end(body);
        return;
      } catch {
        break;
      }
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    serveStatic(req, res).catch((err) => {
      log('static error', err);
      if (!res.headersSent) res.writeHead(500).end('error');
    });
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: NET.maxMessageBytes });

  wss.on('connection', (ws) => {
    const session = lobby.connect(ws);
    ws.on('message', (data, isBinary) => {
      if (!isBinary) session.message(data.toString());
    });
    ws.on('close', session.closed);
    ws.on('error', () => {});
  });

  const stopLoop = startFixedLoop(() => lobby.tick());

  return {
    server,
    rooms,
    listen() {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address())));
    },
    close() {
      stopLoop();
      for (const c of wss.clients) c.terminate();
      wss.close();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT) || 8080;
  const host = process.env.HOST || '0.0.0.0';
  const app = createServer({ port, host });
  const addr = await app.listen();
  console.log(`Riftline 서버 실행 중: http://localhost:${addr.port}`);
  for (const ip of lanAddresses()) console.log(`  같은 네트워크에서 접속: http://${ip}:${addr.port}`);
  const shutdown = () => {
    console.log('서버 종료 중...');
    app.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
