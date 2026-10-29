// 3인칭 히어로 모델 인스턴스와 절차 애니메이션(걷기·조준 피치·사망).
import * as THREE from 'three';
import { HEROES } from './shared/heroes.js';
import { TEAM_COLORS } from './shared/constants.js';
import { assets } from './assets.js';

const PART_NAMES = ['hips', 'torso', 'head', 'legL', 'legR', 'armL', 'armR', 'weapon', 'muzzle'];

// GLB 가 없을 때 쓰는 단순 모델. 노드 이름·계층은 실제 애셋 규격과 같다.
function buildFallbackHero(heroId) {
  const h = HEROES[heroId];
  const prim = new THREE.MeshStandardMaterial({ color: h.colors.primary, roughness: 0.6, metalness: 0.2 });
  const acc = new THREE.MeshStandardMaterial({ color: h.colors.accent, roughness: 0.5 });
  const team = new THREE.MeshStandardMaterial({ color: '#ffffff', name: 'Team' });
  team.name = 'Team';
  const s = h.height / 1.8;
  const box = (w, hh, d, mat, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w * s, hh * s, d * s), mat);
    m.position.set(x * s, y * s, z * s);
    return m;
  };
  const node = (name, x, y, z) => {
    const g = new THREE.Group();
    g.name = name;
    g.position.set(x * s, y * s, z * s);
    return g;
  };
  const root = node('root', 0, 0, 0);
  const hips = node('hips', 0, 0.9, 0); root.add(hips);
  const legL = node('legL', -0.13, 0, 0); legL.add(box(0.16, 0.9, 0.2, prim, 0, -0.45, 0)); hips.add(legL);
  const legR = node('legR', 0.13, 0, 0); legR.add(box(0.16, 0.9, 0.2, prim, 0, -0.45, 0)); hips.add(legR);
  const torso = node('torso', 0, 0.05, 0); hips.add(torso);
  torso.add(box(0.46, 0.55, 0.28, prim, 0, 0.3, 0));
  torso.add(box(0.48, 0.08, 0.3, team, 0, 0.12, 0));
  const head = node('head', 0, 0.6, 0); torso.add(head);
  head.add(box(0.26, 0.26, 0.26, acc, 0, 0.14, 0));
  const armL = node('armL', -0.3, 0.5, 0); armL.add(box(0.12, 0.12, 0.45, prim, 0.05, -0.1, -0.2)); torso.add(armL);
  const armR = node('armR', 0.3, 0.5, 0); armR.add(box(0.12, 0.12, 0.45, prim, -0.05, -0.1, -0.2)); torso.add(armR);
  const weapon = node('weapon', 0.12, 0.38, -0.35); weapon.add(box(0.1, 0.14, 0.6, acc, 0, 0, -0.2)); torso.add(weapon);
  const muzzle = node('muzzle', 0, 0, -0.5); weapon.add(muzzle);
  return root;
}

export function cloneHeroScene(heroId) {
  const src = assets.heroes[heroId];
  return src ? src.clone(true) : buildFallbackHero(heroId);
}

export class HeroModel {
  constructor(heroId, team) {
    this.heroId = heroId;
    this.hero = HEROES[heroId];
    this.group = new THREE.Group();
    this.root = cloneHeroScene(heroId);
    this.group.add(this.root);
    this.nodes = {};
    for (const n of PART_NAMES) this.nodes[n] = this.root.getObjectByName(n) || null;
    this.base = {};
    for (const n of PART_NAMES) if (this.nodes[n]) this.base[n] = this.nodes[n].rotation.clone();
    this.weaponBaseZ = this.nodes.weapon ? this.nodes.weapon.position.z : 0;
    this.materials = [];
    this.root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      o.material = o.material.clone();
      this.materials.push(o.material);
    });
    this.setTeam(team);
    this.phase = 0;
    this.deadT = -1;
    this.recoil = 0;
    this.glow = 0;
  }

  setTeam(team) {
    this.team = team;
    const c = new THREE.Color(TEAM_COLORS[team]);
    for (const m of this.materials) {
      if (m.name === 'Team') {
        m.color.copy(c);
        if (m.emissive) {
          m.emissive.copy(c);
          m.emissiveIntensity = 0.9;
        }
      }
    }
  }

  setXray(on) {
    if (this.xray === on) return;
    this.xray = on;
    for (const m of this.materials) {
      m.depthTest = !on;
      m.transparent = on;
      m.opacity = on ? 0.85 : 1;
    }
    this.group.renderOrder = on ? 10 : 0;
  }

  kick() {
    this.recoil = 1;
  }

  // s: { x,y,z, vx,vz, onGround, yaw, pitch, alive, flags }
  update(dt, s) {
    this.group.position.set(s.x, s.y, s.z);
    this.group.rotation.y = s.yaw;
    const n = this.nodes;

    if (!s.alive) {
      if (this.deadT < 0) this.deadT = 0;
      this.deadT += dt;
      const f = Math.min(1, this.deadT / 0.45);
      this.root.rotation.x = -f * (Math.PI / 2) * 0.95;
      this.root.position.y = f * 0.15;
      this.group.visible = this.deadT < 2.5;
      return;
    }
    if (this.deadT >= 0) {
      this.deadT = -1;
      this.root.rotation.x = 0;
      this.root.position.y = 0;
    }
    this.group.visible = true;

    const speed = Math.hypot(s.vx, s.vz);
    const moveF = Math.min(1, speed / this.hero.speed);
    this.phase += dt * (4 + speed * 1.3);
    // 진행 방향 기준 앞뒤 판정(뒷걸음이면 다리 위상 반전)
    const fwd = -(s.vx * Math.sin(s.yaw) + s.vz * Math.cos(s.yaw));
    const dir = fwd >= -0.1 ? 1 : -1;
    const swing = Math.sin(this.phase) * 0.7 * moveF * dir;

    if (n.legL && n.legR) {
      if (s.onGround) {
        n.legL.rotation.x = this.base.legL.x + swing;
        n.legR.rotation.x = this.base.legR.x - swing;
      } else {
        n.legL.rotation.x = this.base.legL.x + 0.5;
        n.legR.rotation.x = this.base.legR.x - 0.25;
      }
    }
    if (n.hips) n.hips.position.y = (this.hipsY ??= n.hips.position.y) + Math.abs(Math.cos(this.phase)) * 0.04 * moveF;
    if (n.torso) n.torso.rotation.x = this.base.torso.x + s.pitch * 0.75;
    if (n.head) n.head.rotation.x = this.base.head.x + s.pitch * 0.25;
    if (n.armL) n.armL.rotation.x = this.base.armL.x + Math.sin(this.phase) * 0.08 * moveF;
    this.recoil = Math.max(0, this.recoil - dt * 8);
    if (n.weapon) n.weapon.position.z = this.weaponBaseZ + this.recoil * 0.08;

    // 상태 발광(요새화·오버드라이브)
    const glowTarget = (s.flags & (2 | 4)) ? 1 : 0;
    this.glow += (glowTarget - this.glow) * Math.min(1, dt * 8);
    for (const m of this.materials) {
      if (m.name === 'Team' || !m.emissive) continue;
      if (this.glow > 0.01) {
        m.emissive.setRGB(0.25 * this.glow, 0.18 * this.glow, 0.05 * this.glow);
      } else if (m.emissive.r) {
        m.emissive.setRGB(0, 0, 0);
      }
    }
  }

  muzzleWorld(out) {
    if (this.nodes.muzzle) return this.nodes.muzzle.getWorldPosition(out);
    return out.set(this.group.position.x, this.group.position.y + this.hero.eye - 0.2, this.group.position.z);
  }

  dispose() {
    this.group.removeFromParent();
    for (const m of this.materials) m.dispose();
  }
}

// 1인칭 무기 모델
export function buildViewmodel(heroId) {
  const src = assets.weapons[heroId];
  let obj;
  if (src) {
    obj = src.clone(true);
  } else {
    const h = HEROES[heroId];
    obj = new THREE.Group();
    obj.name = 'weapon';
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.12, 0.55), new THREE.MeshStandardMaterial({ color: h.colors.accent }));
    body.position.z = -0.2;
    obj.add(body);
    const muzzle = new THREE.Object3D();
    muzzle.name = 'muzzle';
    muzzle.position.z = -0.5;
    obj.add(muzzle);
  }
  obj.traverse((o) => {
    if (o.isMesh) {
      o.material = o.material.clone();
      o.castShadow = false;
      o.receiveShadow = false;
    }
  });
  return obj;
}
