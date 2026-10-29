// DOM 기반 HUD.
import { HEROES, ROLES } from './shared/heroes.js';
import { MATCH } from './shared/constants.js';

const $ = (id) => document.getElementById(id);

export const CAUSE_LABEL = {
  kodiak: '스크랩 캐넌', 'kodiak-ram': '돌진', 'kodiak-slam': '지진 강타',
  vex: '펄스 라이플', 'vex-mine': '쇼크 지뢰',
  ember: '플라즈마 런처', 'ember-napalm': '네이팜', 'ember-meteor': '유성 낙하',
  rook: '레일건', 'rook-turret': '센트리 드론',
  sol: '바이오 구슬', fall: '추락',
};

const CROSSHAIR = { kodiak: 'circle', vex: 'cross', ember: 'cross', rook: 'dot', sol: 'cross' };

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTime(s) {
  s = Math.max(0, Math.ceil(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export class Hud {
  constructor() {
    this.root = $('hud');
    this.heroId = null;
    this.hitTimer = 0;
    this.announceTimer = 0;
    this.toastTimer = 0;
    this.tagPool = [];
    this.tagsEl = $('tags');
  }

  show(on) {
    this.root.hidden = !on;
  }

  setHero(heroId) {
    if (this.heroId === heroId) return;
    this.heroId = heroId;
    const h = HEROES[heroId];
    $('hero-name').textContent = `${h.name} · ${ROLES[h.role]}`;
    $('ab-shift').querySelector('.nm').textContent = h.shift.name;
    $('ab-e').querySelector('.nm').textContent = h.e.name;
    $('ab-q').querySelector('.nm').textContent = h.q.name;
    $('ammo-max').textContent = `/ ${h.weapon.mag}`;
    $('crosshair').className = CROSSHAIR[heroId] || 'cross';
  }

  ability(id, cd, ready, label) {
    const el = $(id);
    el.classList.toggle('ready', ready);
    el.classList.toggle('cooling', !ready);
    el.querySelector('.cd').textContent = label ?? (ready ? '' : Math.ceil(cd));
  }

  updateMe(me) {
    if (!me || !me.hero) return;
    const h = HEROES[me.hero];
    this.setHero(me.hero);
    const frac = Math.max(0, me.hp / h.hp);
    $('hp-bar').style.width = `${frac * 100}%`;
    $('hp-bar').classList.toggle('low', frac < 0.35);
    $('hp-text').textContent = `${Math.max(0, Math.ceil(me.hp))} / ${h.hp}`;
    $('damage-flash').classList.toggle('low', me.alive && frac < 0.3);
    const infinite = me.st[1] > 0;
    $('ammo').textContent = infinite ? '∞' : me.ammo;
    $('reload-bar').style.width = me.rl > 0 ? `${(1 - me.rl / h.weapon.reload) * 100}%` : '0';
    this.ability('ab-shift', me.cs, me.cs <= 0);
    this.ability('ab-e', me.ce, me.ce <= 0);
    this.ability('ab-q', 0, me.ult >= 100, `${me.ult}%`);
    const st = [];
    if (me.st[0] > 0) st.push('방벽 장갑');
    if (me.st[1] > 0) st.push('오버드라이브');
    if (me.st[2] > 0) st.push('둔화');
    if (me.st[3] > 0) st.push('정찰 펄스');
    if (me.ph) st.push(`다음 부활: ${HEROES[me.ph].name}`);
    const html = st.map((s) => `<span>${esc(s)}</span>`).join('');
    if (this.lastStatus !== html) { $('status-icons').innerHTML = html; this.lastStatus = html; }
    $('respawn').hidden = !!me.alive;
    if (!me.alive) $('respawn-text').textContent = `부활까지 ${Math.ceil(me.rsp)}초`;
  }

  updateObjective(ob, myTeam) {
    const [phase, phaseT, owner, capTeam, cap, s0, s1, contested, c0, c1, winner] = ob;
    $('obj-s0').textContent = `${Math.floor(s0)}%`;
    $('obj-s1').textContent = `${Math.floor(s1)}%`;
    const ring = $('obj-ring');
    const colors = ['#3aa0ff', '#ff4d4d'];
    const point = $('obj-point');
    point.classList.toggle('contested', !!contested);
    ring.style.stroke = capTeam >= 0 ? colors[capTeam] : '#fff';
    ring.style.strokeDashoffset = `${113.1 * (1 - cap)}`;
    point.querySelector('.ring-bg').style.fill = owner >= 0 ? (owner === 0 ? 'rgba(58,160,255,0.55)' : 'rgba(255,77,77,0.55)') : 'rgba(0,0,0,0.45)';
    let title = '', sub = '';
    if (phase === 0) {
      title = `준비 시간 ${fmtTime(phaseT)}`;
      sub = '곧 거점이 활성화됩니다';
    } else if (phase === 1) {
      title = owner < 0 ? '거점을 점령하십시오' : owner === myTeam ? '거점을 방어하십시오' : '거점을 탈환하십시오';
      if (contested) sub = '거점 경합 중';
      else if (c0 || c1) sub = `거점 위 인원 — 청 ${c0} : 적 ${c1}`;
      const ownScore = owner >= 0 ? [s0, s1][owner] : 0;
      if (owner >= 0 && ownScore >= MATCH.winScore - 0.02 && (owner === 0 ? c1 : c0)) sub = '추가 시간!';
    } else {
      title = winner === myTeam ? '승리!' : '패배';
      sub = `다음 경기까지 ${Math.ceil(phaseT)}초`;
    }
    $('obj-phase').textContent = title;
    $('obj-sub').textContent = sub;
  }

  hitmarker(head, kill) {
    const el = $('hitmarker');
    el.className = `show${head ? ' head' : ''}${kill ? ' kill' : ''}`;
    clearTimeout(this.hitTimer);
    this.hitTimer = setTimeout(() => { el.className = ''; }, kill ? 260 : 110);
  }

  damageDir(angle) {
    const d = document.createElement('div');
    d.className = 'dmg-dir';
    d.style.transform = `rotate(${angle}rad)`;
    $('dmg-dirs').appendChild(d);
    setTimeout(() => d.remove(), 950);
    const f = $('damage-flash');
    f.classList.add('hit');
    setTimeout(() => f.classList.remove('hit'), 60);
  }

  killfeed(killer, victim, cause, isMe) {
    const el = document.createElement('div');
    el.className = `kf${isMe ? ' me' : ''}`;
    const k = killer ? `<span class="${killer.team === 0 ? 'b' : 'r'}">${esc(killer.name)}</span>` : '';
    const v = `<span class="${victim.team === 0 ? 'b' : 'r'}">${esc(victim.name)}</span>`;
    el.innerHTML = `${k}<span class="w">[${esc(CAUSE_LABEL[cause] || '처치')}]</span>${v}`;
    const feed = $('killfeed');
    feed.prepend(el);
    while (feed.children.length > 6) feed.lastChild.remove();
    setTimeout(() => el.remove(), 6200);
  }

  announce(text, sub = '', color = '#fff', dur = 2.2) {
    const el = $('announce');
    el.innerHTML = `${esc(text)}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}`;
    el.style.color = color;
    el.style.opacity = '1';
    clearTimeout(this.announceTimer);
    this.announceTimer = setTimeout(() => { el.style.opacity = '0'; }, dur * 1000);
  }

  toast(text, dur = 2) {
    const el = $('toast');
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { el.style.opacity = '0'; }, dur * 1000);
  }

  chat(name, team, text) {
    const el = document.createElement('div');
    if (name === null) {
      el.className = 'sys';
      el.textContent = text;
    } else {
      el.innerHTML = `<span class="${team === 0 ? 'b' : 'r'}">${esc(name)}</span>: ${esc(text)}`;
    }
    const log = $('chat-log');
    log.appendChild(el);
    while (log.children.length > 8) log.firstChild.remove();
    setTimeout(() => el.remove(), 10000);
  }

  scoreboard(show, roster, myId) {
    $('scoreboard').hidden = !show;
    if (!show) return;
    for (const t of [0, 1]) {
      const rows = roster.filter((p) => p.team === t).sort((a, b) => b.k - a.k || a.d - b.d);
      $(`sb-${t}`).innerHTML = rows.map((p) => `<tr class="${p.id === myId ? 'me' : ''}"><td>${esc(p.name)}</td>` +
        `<td>${p.hero ? esc(HEROES[p.hero].name) : '-'}</td><td class="num">${p.k}</td><td class="num">${p.d}</td>` +
        `<td class="num">${p.dmg}</td><td class="num">${p.heal}</td></tr>`).join('');
    }
  }

  // tags: [{ x, y, name, hpFrac, ally, revealed }] — 화면 좌표(px)
  tags(list) {
    while (this.tagPool.length < list.length) {
      const el = document.createElement('div');
      el.className = 'tag';
      el.innerHTML = '<div class="tn"></div><div class="tb"><i></i></div>';
      this.tagsEl.appendChild(el);
      this.tagPool.push(el);
    }
    this.tagPool.forEach((el, i) => {
      const t = list[i];
      if (!t) { el.style.display = 'none'; return; }
      el.style.display = '';
      el.style.left = `${t.x}px`;
      el.style.top = `${t.y}px`;
      el.className = `tag ${t.ally ? 'ally' : 'enemy'}${t.revealed ? ' revealed' : ''}`;
      const tn = el.firstChild;
      if (tn.textContent !== t.name) tn.textContent = t.name;
      el.lastChild.firstChild.style.width = `${Math.max(0, t.hpFrac) * 100}%`;
      el.lastChild.style.display = t.showBar ? '' : 'none';
    });
  }

  dmgNumber(x, y, text, cls) {
    const el = document.createElement('div');
    el.className = `dmgnum ${cls || ''}`;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.textContent = text;
    this.tagsEl.appendChild(el);
    setTimeout(() => el.remove(), 820);
  }

  scope(on) {
    $('scope').hidden = !on;
    $('crosshair').style.visibility = on ? 'hidden' : '';
  }
}
