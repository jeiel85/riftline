// 화면 흐름: 메뉴 → 애셋 로딩 → 접속 → 히어로 선택 → 게임.
import { HEROES, HERO_IDS, ROLES } from './shared/heroes.js';
import { TEAM_NAMES } from './shared/constants.js';
import { Net } from './net.js';
import { Input } from './input.js';
import { Sfx } from './audio.js';
import { loadAssets } from './assets.js';
import { Game } from './game.js';

const $ = (id) => document.getElementById(id);

const SETTINGS_KEY = 'riftline.settings';
const settings = { sens: 1, fov: 70, volume: 0.6, name: '', room: '' };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
} catch {
  // 저장된 설정이 없거나 손상됐으면 기본값을 쓴다
}
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // 저장소를 쓸 수 없는 환경(사생활 보호 모드 등)에서는 이번 세션만 유지
  }
}

const sfx = new Sfx();
sfx.setVolume(settings.volume);
const input = new Input(document.body);
input.sens = settings.sens;

let net = null;
let game = null;
let assetsReady = null;
let selectedHero = null;
let ui = 'menu'; // menu | loading | heroselect | play | pause
let staticHost = false; // 게임 서버가 없는 정적 호스팅(GitHub Pages 등)이면 오프라인 봇전만 가능

function show(id, on) {
  $(id).hidden = !on;
}

function setUi(mode) {
  ui = mode;
  show('menu', mode === 'menu');
  show('loading', mode === 'loading');
  show('hero-select', mode === 'heroselect');
  show('pause', mode === 'pause');
  input.enabled = mode === 'play';
  $('click-to-play').hidden = !(mode === 'play' && !input.locked);
}

// ── 메뉴 ─────────────────────────────────────
$('in-name').value = settings.name || '';
$('in-room').value = settings.room || '';

async function refreshRooms() {
  const ul = $('rooms');
  try {
    const res = await fetch('api/rooms', { cache: 'no-store' });
    if (res.status === 404) return enterStaticMode(); // 게임 서버는 항상 이 경로를 제공한다
    const rooms = await res.json();
    ul.innerHTML = '';
    if (!rooms.length) {
      ul.innerHTML = '<li class="empty">열린 방이 없습니다. 새로 만들어 보세요.</li>';
      return;
    }
    for (const r of rooms) {
      const li = document.createElement('li');
      li.innerHTML = '<span></span><span></span>';
      li.firstChild.textContent = r.code;
      li.lastChild.textContent = `사람 ${r.humans}명 · ${r.teamSize ? `${r.teamSize}v${r.teamSize}` : '봇 없음'}`;
      li.onclick = () => { $('in-room').value = r.code; };
      ul.appendChild(li);
    }
  } catch {
    ul.innerHTML = '<li class="empty">방 목록을 불러오지 못했습니다.</li>';
  }
}
$('btn-refresh').onclick = refreshRooms;
const firstProbe = refreshRooms(); // 정적 호스팅 여부는 이 첫 요청으로 정해진다

function enterStaticMode() {
  staticHost = true;
  $('btn-join').textContent = '봇전 시작';
  $('in-room').closest('label').hidden = true;
  $('room-hint').hidden = true;
  $('btn-offline').hidden = true;
  $('static-note').hidden = false;
  $('room-list').hidden = true;
  if ($('in-teamsize').value === '0') $('in-teamsize').value = '3';
}

$('join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await firstProbe;
  start(staticHost);
});
$('btn-offline').onclick = () => {
  if ($('join-form').reportValidity()) start(true);
};

async function start(local) {
  sfx.init();
  const name = $('in-name').value.trim();
  const room = local ? '오프라인' : $('in-room').value.trim() || 'public';
  const teamSize = Number($('in-teamsize').value);
  settings.name = name;
  if (!local) settings.room = room;
  saveSettings();
  $('menu-error').hidden = true;
  setUi('loading');
  try {
    $('loading-text').textContent = '애셋 불러오는 중…';
    assetsReady ||= loadAssets((f, label) => { $('loading-text').textContent = `애셋 불러오는 중… ${Math.round(f * 100)}% (${label})`; });
    await assetsReady;
    $('loading-text').textContent = local ? '봇전 준비 중…' : '서버에 접속하는 중…';
    await connect(name, room, teamSize, local);
  } catch (err) {
    console.error(err);
    teardown();
    setUi('menu');
    $('menu-error').textContent = err.message || '접속에 실패했습니다.';
    $('menu-error').hidden = false;
  }
}

function connect(name, room, teamSize, local) {
  net = new Net();
  return new Promise((resolve, reject) => {
    let welcomed = false;
    net.on('welcome', (w) => {
      welcomed = true;
      game = new Game({ net, input, sfx, container: $('view'), settings, callbacks: {} });
      game.start(w);
      $('pause-room').textContent = w.room;
      openHeroSelect();
      resolve();
    });
    net.on('error', (m) => {
      if (!welcomed) reject(new Error(m.message));
    });
    net.on('close', () => {
      if (!welcomed) return reject(new Error(local ? '봇전을 시작하지 못했습니다.' : '서버와의 연결이 끊어졌습니다.'));
      teardown();
      setUi('menu');
      $('menu-error').textContent = '서버와의 연결이 끊어졌습니다.';
      $('menu-error').hidden = false;
      if (!staticHost) refreshRooms();
    });
    net.connect({ local })
      .then(() => net.send({ t: 'join', name, room, teamSize }))
      .catch(reject);
  });
}

function teardown() {
  if (game) game.stop();
  game = null;
  if (net) net.close();
  net = null;
  input.unlock();
}

// ── 히어로 선택 ──────────────────────────────────
function renderHeroCards() {
  const wrap = $('hero-cards');
  wrap.innerHTML = '';
  const counts = {};
  if (game) {
    for (const p of game.roster.values()) if (p.team === game.myTeam && p.hero && p.id !== game.myId) counts[p.hero] = (counts[p.hero] || 0) + 1;
  }
  for (const id of HERO_IDS) {
    const h = HEROES[id];
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `hero-card${selectedHero === id ? ' selected' : ''}`;
    card.style.setProperty('--hc', h.colors.accent);
    card.innerHTML = `<span class="hc-role"></span><span class="hc-name"></span><span class="hc-title"></span><span class="hc-hp"></span>${counts[id] ? `<span class="hc-count">아군 ${counts[id]}</span>` : ''}`;
    card.querySelector('.hc-role').textContent = ROLES[h.role];
    card.querySelector('.hc-name').textContent = h.name;
    card.querySelector('.hc-title').textContent = h.title;
    card.querySelector('.hc-hp').textContent = `체력 ${h.hp}`;
    card.onclick = () => {
      selectedHero = id;
      renderHeroCards();
    };
    card.ondblclick = () => {
      selectedHero = id;
      confirmHero();
    };
    wrap.appendChild(card);
  }
  const det = $('hero-detail');
  if (selectedHero) {
    const h = HEROES[selectedHero];
    const w = h.weapon;
    det.innerHTML = `<h3></h3><p></p><div class="abl">
      <div><b>${w.name}</b>${w.type === 'hitscan' ? '즉발' : '투사체'} · 탄창 ${w.mag}<br><em>마우스 왼쪽</em></div>
      <div><b></b><span></span><br><em>Shift · ${h.shift.cooldown}초</em></div>
      <div><b></b><span></span><br><em>E · ${h.e.cooldown}초</em></div>
      <div><b></b><span></span><br><em>Q · 궁극기</em></div></div>`;
    det.querySelector('h3').textContent = `${h.name} — ${h.title}`;
    det.querySelector('p').textContent = h.blurb;
    const cells = det.querySelectorAll('.abl div');
    [h.shift, h.e, h.q].forEach((a, i) => {
      cells[i + 1].querySelector('b').textContent = a.name;
      cells[i + 1].querySelector('span').textContent = a.desc;
    });
  } else {
    det.innerHTML = '<p class="hint">히어로를 고르면 무기와 스킬 설명이 나옵니다. 카드를 더블클릭하면 바로 선택합니다.</p>';
  }
  $('btn-hero-ok').disabled = !selectedHero;
  if (game) $('hs-team-name').textContent = TEAM_NAMES[game.myTeam];
  const note = game && game.me && game.me.hero && !game.canChangeHeroNow() ? '스폰룸 밖에서는 다음 부활 때 변경됩니다.' : '';
  $('hs-note').textContent = note;
}

function openHeroSelect() {
  input.unlock();
  if (game && game.me && game.me.hero) selectedHero = game.me.hero;
  renderHeroCards();
  setUi('heroselect');
}

function confirmHero() {
  if (!selectedHero || !net) return;
  net.send({ t: 'hero', hero: selectedHero });
  setUi('play');
  input.lock();
}

$('btn-hero-ok').onclick = confirmHero;
$('btn-team').onclick = () => {
  if (!net) return;
  net.send({ t: 'team' });
  setTimeout(renderHeroCards, 300);
};

// ── 일시정지·설정 ────────────────────────────────
function syncSettingsUi() {
  $('set-sens').value = settings.sens;
  $('set-fov').value = settings.fov;
  $('set-vol').value = settings.volume;
  $('out-sens').textContent = Number(settings.sens).toFixed(2);
  $('out-fov').textContent = settings.fov;
  $('out-vol').textContent = `${Math.round(settings.volume * 100)}%`;
}
$('set-sens').oninput = (e) => { settings.sens = Number(e.target.value); input.sens = settings.sens; syncSettingsUi(); saveSettings(); };
$('set-fov').oninput = (e) => { settings.fov = Number(e.target.value); syncSettingsUi(); saveSettings(); };
$('set-vol').oninput = (e) => { settings.volume = Number(e.target.value); sfx.setVolume(settings.volume); syncSettingsUi(); saveSettings(); };
syncSettingsUi();

$('btn-resume').onclick = () => {
  setUi('play');
  input.lock();
};
$('btn-change-hero').onclick = openHeroSelect;
$('btn-leave').onclick = () => {
  teardown();
  setUi('menu');
  if (!staticHost) refreshRooms();
};

input.onLockChange = (locked) => {
  if (!game) return;
  if (!locked && ui === 'play') {
    setUi('pause');
    $('pause-ping').textContent = net && net.rtt ? `${Math.round(net.rtt * 1000)}ms` : '-';
  }
  $('click-to-play').hidden = !(ui === 'play' && !locked);
};

document.addEventListener('mousedown', (e) => {
  if (ui === 'play' && !input.locked && e.target.closest('#view, #hud')) {
    sfx.init();
    input.lock();
  }
});

// 게임 단축키. true 를 돌려주면 이동 입력으로 쓰지 않는다.
input.onKey = (e) => {
  if (!game) return false;
  const chat = $('chat-input');
  if (game.chatOpen) {
    if (e.code === 'Enter') {
      const text = chat.value.trim();
      if (text) net.send({ t: 'chat', text });
      chat.value = '';
      chat.hidden = true;
      chat.blur();
      game.chatOpen = false;
      input.enabled = ui === 'play';
      e.preventDefault();
    } else if (e.code === 'Escape') {
      chat.value = '';
      chat.hidden = true;
      chat.blur();
      game.chatOpen = false;
      input.enabled = ui === 'play';
    }
    return true;
  }
  if (ui !== 'play') return false;
  if (e.code === 'Tab') {
    e.preventDefault();
    if (!e.repeat) game.setScoreboard(true);
    return true;
  }
  if (e.code === 'Enter') {
    e.preventDefault();
    game.chatOpen = true;
    input.enabled = false;
    input.release();
    chat.hidden = false;
    setTimeout(() => chat.focus(), 0);
    return true;
  }
  if (e.code === 'KeyH' && !e.repeat) {
    openHeroSelect();
    return true;
  }
  return false;
};
window.addEventListener('keyup', (e) => {
  if (e.code === 'Tab' && game) game.setScoreboard(false);
});

window.addEventListener('beforeunload', () => {
  if (net) net.close();
});

setUi('menu');

// 개발용: 주소에 ?debug 가 있으면 콘솔에서 상태를 볼 수 있게 노출한다.
if (new URLSearchParams(location.search).has('debug')) {
  window.riftline = { get game() { return game; }, input, sfx, get net() { return net; } };
}
