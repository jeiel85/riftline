// 히어로 정의. 서버(판정), 클라이언트(HUD·예측), 블렌더 애셋(외형 색상)이 같이 쓴다.
// 모든 히어로는 Riftline 고유 캐릭터다.

export const ROLES = {
  tank: '돌격',
  damage: '공격',
  support: '지원',
};

export const HEROES = {
  kodiak: {
    id: 'kodiak',
    name: '코디악',
    title: '강철 돌파병',
    role: 'tank',
    blurb: '두꺼운 장갑으로 전선을 밀어붙이는 근접 탱커. 돌진으로 적 진형을 흩트린다.',
    colors: { primary: '#5b6470', accent: '#e8892c' },
    hp: 450,
    speed: 5.0,
    radius: 0.55,
    height: 2.1,
    eye: 1.85,
    headRadius: 0.3,
    ultCost: 1400,
    weapon: {
      name: '스크랩 캐넌',
      type: 'hitscan',
      pellets: 8,
      damage: 10,
      spread: 0.07,
      interval: 0.75,
      mag: 6,
      reload: 2.0,
      range: 35,
      falloff: [10, 20, 0.4],
      headMult: 1.5,
    },
    shift: {
      type: 'dash', name: '돌진', desc: '전방으로 돌진해 부딪힌 적에게 피해를 주고 밀쳐낸다.',
      cooldown: 7, duration: 0.45, speed: 15, dir: 'forward',
      damage: 40, knockback: 10,
    },
    e: {
      type: 'fortify', name: '방벽 장갑', desc: '3초 동안 받는 피해 50% 감소.',
      cooldown: 10, duration: 3, reduction: 0.5,
    },
    q: {
      type: 'slam', name: '지진 강타', desc: '높이 도약한 뒤 내려찍어 주변 적에게 큰 피해를 주고 띄운다.',
      up: 11, forward: 9, radius: 8, damage: 130, knockup: 8,
    },
  },

  vex: {
    id: 'vex',
    name: '벡스',
    title: '위상 침투자',
    role: 'damage',
    blurb: '빠른 기동과 연사로 측면을 파고드는 돌격 소총수.',
    colors: { primary: '#e9edf2', accent: '#2fd6c8' },
    hp: 200,
    speed: 6.2,
    radius: 0.4,
    height: 1.8,
    eye: 1.6,
    headRadius: 0.22,
    ultCost: 1300,
    weapon: {
      name: '펄스 라이플',
      type: 'hitscan',
      pellets: 1,
      damage: 17,
      spread: 0.012,
      interval: 0.1,
      mag: 30,
      reload: 1.4,
      range: 80,
      falloff: [25, 40, 0.5],
      headMult: 2,
    },
    shift: {
      type: 'dash', name: '위상 대시', desc: '이동 방향으로 순간 돌진한다.',
      cooldown: 5, duration: 0.18, speed: 26, dir: 'input',
    },
    e: {
      type: 'mine', name: '쇼크 지뢰', desc: '지뢰를 던진다. 적이 다가오면 폭발해 피해와 둔화를 준다.',
      cooldown: 9, throwSpeed: 18, armTime: 0.6, triggerRadius: 2.5, blastRadius: 3,
      damage: 70, slow: 0.5, slowTime: 2, lifetime: 30,
    },
    q: {
      type: 'overdrive', name: '오버드라이브', desc: '6초 동안 연사 속도 2배, 이동 속도 30% 증가, 탄약 무한.',
      duration: 6, fireRateMult: 2, speedMult: 1.3,
    },
  },

  ember: {
    id: 'ember',
    name: '엠버',
    title: '플라즈마 포격수',
    role: 'damage',
    blurb: '폭발하는 플라즈마 탄으로 지역을 장악하는 포격수. 제트 부스트로 고지대를 노린다.',
    colors: { primary: '#7a2a24', accent: '#ff9a2e' },
    hp: 225,
    speed: 5.5,
    radius: 0.42,
    height: 1.85,
    eye: 1.65,
    headRadius: 0.23,
    ultCost: 1600,
    weapon: {
      name: '플라즈마 런처',
      type: 'projectile',
      projectile: 'plasma',
      speed: 38,
      projRadius: 0.2,
      damage: 75,
      splash: 50,
      splashRadius: 2.8,
      selfKnockback: 9,
      interval: 0.85,
      mag: 5,
      reload: 1.7,
      gravity: 0,
      lifetime: 3,
    },
    shift: {
      type: 'impulse', name: '제트 부스트', desc: '높이 솟구친다.',
      cooldown: 8, up: 11, back: 0,
    },
    e: {
      type: 'napalm', name: '네이팜 캐니스터', desc: '착탄 지점에 4초간 불타는 지대를 만든다.',
      cooldown: 12, throwSpeed: 16, radius: 3.5, duration: 4, dps: 32,
    },
    q: {
      type: 'meteor', name: '유성 낙하', desc: '조준한 지역에 플라즈마 유성을 연속으로 떨어뜨린다.',
      range: 60, delay: 0.8, count: 10, duration: 2.5, area: 6, splashRadius: 3, damage: 60,
    },
  },

  rook: {
    id: 'rook',
    name: '루크',
    title: '장거리 감시병',
    role: 'damage',
    blurb: '레일건으로 먼 거리의 적을 저격하고 센트리 드론으로 지점을 지킨다.',
    colors: { primary: '#3d4a33', accent: '#b7f04a' },
    hp: 175,
    speed: 5.5,
    radius: 0.4,
    height: 1.8,
    eye: 1.6,
    headRadius: 0.22,
    ultCost: 1400,
    weapon: {
      name: '레일건',
      type: 'hitscan',
      pellets: 1,
      damage: 80,
      spread: 0,
      interval: 1.15,
      mag: 6,
      reload: 2.0,
      range: 150,
      falloff: null,
      headMult: 2.5,
      zoomFov: 30,
    },
    shift: {
      type: 'impulse', name: '그래플 점프', desc: '뒤쪽 위로 크게 도약해 거리를 벌린다.',
      cooldown: 7, up: 8.5, back: 11,
    },
    e: {
      type: 'turret', name: '센트리 드론', desc: '조준 지점에 15초간 적을 자동 사격하는 드론을 설치한다.',
      cooldown: 14, range: 10, hp: 120, duration: 15, fireRange: 25, interval: 0.25, damage: 9,
    },
    q: {
      type: 'recon', name: '정찰 펄스', desc: '8초 동안 팀 전체가 벽 너머 적을 보고, 루크의 피해량이 30% 증가한다.',
      duration: 8, damageMult: 1.3,
    },
  },

  sol: {
    id: 'sol',
    name: '솔',
    title: '생명 공학자',
    role: 'support',
    blurb: '아군을 치유하고 적을 공격하는 생체 구슬을 쏘는 지원가.',
    colors: { primary: '#f1ede2', accent: '#f2c53d' },
    hp: 225,
    speed: 5.6,
    radius: 0.4,
    height: 1.8,
    eye: 1.6,
    headRadius: 0.22,
    ultCost: 1500,
    weapon: {
      name: '바이오 구슬',
      type: 'projectile',
      projectile: 'orb',
      speed: 45,
      projRadius: 0.35,
      damage: 30,
      heal: 40,
      splash: 0,
      splashRadius: 0,
      interval: 0.35,
      mag: 20,
      reload: 1.5,
      gravity: 0,
      lifetime: 2,
    },
    shift: {
      type: 'dash', name: '글라이드 스텝', desc: '이동 방향으로 미끄러지듯 이동한다.',
      cooldown: 6, duration: 0.3, speed: 13, dir: 'input',
    },
    e: {
      type: 'pulse', name: '회복 파동', desc: '주변 8m 아군(자신 포함)의 체력을 80 회복한다.',
      cooldown: 10, radius: 8, heal: 80,
    },
    q: {
      type: 'sanctuary', name: '성역', desc: '6초간 유지되는 돔을 펼친다. 안의 아군은 빠르게 회복하고 받는 피해가 줄어든다.',
      radius: 6, duration: 6, hps: 60, reduction: 0.3,
    },
  },
};

export const HERO_IDS = Object.keys(HEROES);

export function isHeroId(id) {
  return typeof id === 'string' && Object.hasOwn(HEROES, id);
}

// 히트박스: 몸통은 발~어깨 AABB, 머리는 구.
export function headCenterY(hero) {
  return hero.height - hero.headRadius;
}

export function bodyTopY(hero) {
  return hero.height - hero.headRadius * 2;
}
