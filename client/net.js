// WebSocket 연결, 서버 시계 추정, 지연(RTT) 측정.

// 오프라인 모드용: 브라우저 안 서버(local-server.js Worker)를 WebSocket 과 같은 모양으로 감싼다.
class LocalSocket {
  constructor() {
    this.readyState = 0;
    this.onopen = this.onerror = this.onclose = this.onmessage = null;
    this.worker = new Worker(new URL('./local-server.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev) => {
      const d = ev.data;
      if (typeof d === 'string') {
        if (this.onmessage) this.onmessage({ data: d });
      } else if (d && d.ctl === 'open') {
        this.readyState = 1;
        if (this.onopen) this.onopen();
      } else if (d && d.ctl === 'close') {
        this.finish({ code: d.code, reason: d.reason });
      }
    };
    this.worker.onerror = (ev) => {
      console.error('local server error', ev.message || ev);
      ev.preventDefault();
      if (this.readyState === 0 && this.onerror) this.onerror(ev);
      this.finish({ code: 1011, reason: 'local server error' });
    };
  }

  send(text) {
    if (this.readyState === 1) this.worker.postMessage(text);
  }

  close() {
    this.finish({ code: 1000, reason: '' });
  }

  finish(ev) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.worker.terminate();
    if (this.onclose) this.onclose(ev);
  }
}

export class Net {
  constructor() {
    this.ws = null;
    this.handlers = {};
    this.rtt = 0;
    this.clockOffset = null; // serverTime - localTime(초)
    this.pingTimer = null;
    this.closedByUser = false;
  }

  on(type, fn) {
    this.handlers[type] = fn;
  }

  // local=true 면 서버 없이 브라우저 안에서 봇전을 돌린다.
  connect({ local = false } = {}) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return new Promise((resolve, reject) => {
      const url = new URL('ws', location.href); // 페이지와 같은 경로 아래 /ws
      url.protocol = proto;
      const ws = local ? new LocalSocket() : new WebSocket(url);
      this.ws = ws;
      let opened = false;
      ws.onopen = () => {
        opened = true;
        this.pingTimer = setInterval(() => this.send({ t: 'ping', ct: performance.now() }), 1000);
        resolve();
      };
      ws.onerror = () => {
        if (!opened) reject(new Error(local ? '이 브라우저에서는 오프라인 모드를 시작할 수 없습니다.' : '서버에 연결할 수 없습니다.'));
      };
      ws.onclose = (ev) => {
        clearInterval(this.pingTimer);
        if (opened && !this.closedByUser && this.handlers.close) this.handlers.close(ev);
      };
      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.t === 'pong') {
          const rtt = (performance.now() - msg.ct) / 1000;
          this.rtt = this.rtt ? this.rtt * 0.8 + rtt * 0.2 : rtt;
          return;
        }
        if (msg.t === 's') this.syncClock(msg.tm);
        const h = this.handlers[msg.t];
        if (h) h(msg);
      };
    });
  }

  // 스냅샷 시각으로 서버 시계를 추정한다. 갑자기 크게 어긋나면 바로 맞춘다.
  syncClock(serverTime) {
    const sample = serverTime - performance.now() / 1000;
    if (this.clockOffset === null || Math.abs(sample - this.clockOffset) > 0.25) this.clockOffset = sample;
    else this.clockOffset += (sample - this.clockOffset) * 0.05;
  }

  serverTime() {
    return performance.now() / 1000 + (this.clockOffset || 0);
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  close() {
    this.closedByUser = true;
    clearInterval(this.pingTimer);
    if (this.ws) this.ws.close();
  }
}
