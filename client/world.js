// 씬 구성: 하늘·조명·맵·거점·회복 팩·투사체/지대/드론 같은 동적 엔티티.
import * as THREE from 'three';
import { MAP } from './shared/map.js';
import { TEAM_COLORS } from './shared/constants.js';
import { assets } from './assets.js';

const KIND_COLORS = {
  ground: '#5d6168', wall: '#7b8088', spawn: '#8a8f99', roof: '#4a4f58', platform: '#8c7f6c', stairs: '#9a8d78',
  cover: '#a39885', crate: '#a8743a', pillar: '#6f7580', point: '#c9c2b2', bridge: '#6b7380', railing: '#d2a23a', building: '#878b8f',
};

function buildFallbackMap() {
  const g = new THREE.Group();
  const mats = {};
  for (const b of MAP.boxes) {
    const size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
    const mat = mats[b.kind] ||= new THREE.MeshStandardMaterial({ color: KIND_COLORS[b.kind] || '#888', roughness: 0.85 });
    const m = new THREE.Mesh(new THREE.BoxGeometry(...size), mat);
    m.position.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
    g.add(m);
  }
  return g;
}

function skyMesh() {
  const geo = new THREE.SphereGeometry(400, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color('#2f6fb8') },
      horizon: { value: new THREE.Color('#d9c7a8') },
      bottom: { value: new THREE.Color('#40444c') },
      sunDir: { value: new THREE.Vector3(0.45, 0.55, 0.3).normalize() },
    },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 bottom; uniform vec3 sunDir; varying vec3 vDir;
      void main(){
        float h = vDir.y;
        vec3 c = h > 0.0 ? mix(horizon, top, pow(h, 0.55)) : mix(horizon, bottom, pow(-h, 0.4));
        float s = max(dot(normalize(vDir), sunDir), 0.0);
        c += vec3(1.0, 0.85, 0.6) * (pow(s, 600.0) * 4.0 + pow(s, 8.0) * 0.18);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const m = new THREE.Mesh(geo, mat);
  m.renderOrder = -1;
  m.frustumCulled = false;
  return m;
}

function glowSphere(radius, color, haloScale = 2.2) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 8), new THREE.MeshBasicMaterial({ color })));
  const halo = new THREE.Mesh(new THREE.SphereGeometry(radius * haloScale, 12, 8),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
  g.add(halo);
  return g;
}

function propOr(name, fallback) {
  const src = assets.props[name];
  const obj = src ? src.clone(true) : fallback();
  obj.traverse((o) => {
    if (o.isMesh) {
      o.material = o.material.clone();
      o.castShadow = true;
    }
  });
  return obj;
}

export class World {
  constructor() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#9fb3c8');
    this.scene.fog = new THREE.Fog('#c8c2b4', 60, 220);
    this.scene.add(skyMesh());

    const hemi = new THREE.HemisphereLight('#cfe3ff', '#5a5246', 1.1);
    // 지붕 아래(스폰룸·창고)가 너무 어둡지 않게 약한 전역광을 더한다
    this.scene.add(hemi, new THREE.AmbientLight('#ffffff', 0.35));
    const sun = new THREE.DirectionalLight('#fff1dc', 2.6);
    sun.position.set(45, 55, 30);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -50; sc.right = 50; sc.top = 36; sc.bottom = -36; sc.near = 10; sc.far = 160;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    this.scene.add(sun, sun.target);
    this.sun = sun;

    const map = assets.map ? assets.map : buildFallbackMap();
    map.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.scene.add(map);

    // 거점 표시: 바닥 고리 + 반투명 기둥
    const P = MAP.point;
    this.pointRing = new THREE.Mesh(new THREE.RingGeometry(P.radius - 0.25, P.radius, 64).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
    this.pointRing.position.set(P.pos[0], P.pos[1] + 0.03, P.pos[2]);
    this.pointFill = new THREE.Mesh(new THREE.CircleGeometry(P.radius - 0.25, 64).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.08, depthWrite: false }));
    this.pointFill.position.copy(this.pointRing.position);
    this.pointWall = new THREE.Mesh(new THREE.CylinderGeometry(P.radius, P.radius, 3, 64, 1, true),
      new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
        uniforms: { color: { value: new THREE.Color('#ffffff') }, time: { value: 0 } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: `uniform vec3 color; uniform float time; varying vec2 vUv;
          void main(){ float a = (1.0 - vUv.y) * 0.22 * (0.75 + 0.25 * sin(vUv.x * 60.0 + time * 2.0)); gl_FragColor = vec4(color * a, a); }`,
      }));
    this.pointWall.position.set(P.pos[0], P.pos[1] + 1.5, P.pos[2]);
    this.scene.add(this.pointRing, this.pointFill, this.pointWall);

    // 회복 팩
    this.packs = MAP.healthPacks.map((h) => {
      const name = h.size === 'large' ? 'healthpack_large' : 'healthpack_small';
      const obj = propOr(name, () => {
        const g = new THREE.Group();
        const s = h.size === 'large' ? 0.5 : 0.35;
        g.add(new THREE.Mesh(new THREE.BoxGeometry(s, s, s), new THREE.MeshStandardMaterial({ color: '#3fbf6a', emissive: '#1f7a3a' })));
        return g;
      });
      obj.position.set(h.pos[0], h.pos[1] + 0.35, h.pos[2]);
      this.scene.add(obj);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.6, 0.06, 20), new THREE.MeshStandardMaterial({ color: '#2a2f36', emissive: '#1d6b3a', emissiveIntensity: 0.6 }));
      base.position.set(h.pos[0], h.pos[1] + 0.03, h.pos[2]);
      base.receiveShadow = true;
      this.scene.add(base);
      return obj;
    });

    this.ents = new Map();
    this.time = 0;
  }

  setPoint(owner, capTeam, cap, active) {
    const c = new THREE.Color(owner >= 0 ? TEAM_COLORS[owner] : '#ffffff');
    if (capTeam >= 0 && cap > 0) c.lerp(new THREE.Color(TEAM_COLORS[capTeam]), Math.min(1, 0.3 + cap * 0.7) * (Math.sin(this.time * 8) * 0.25 + 0.75));
    this.pointRing.material.color.copy(c);
    this.pointFill.material.color.copy(c);
    this.pointWall.material.uniforms.color.value.copy(c);
    this.pointWall.visible = active;
    this.pointRing.material.opacity = active ? 0.9 : 0.35;
  }

  setPacks(mask) {
    this.packs.forEach((p, i) => { p.visible = !!(mask & (1 << i)); });
  }

  makeEntity(type, team, extra) {
    const tc = TEAM_COLORS[team] || '#ffffff';
    switch (type) {
      case 'p': return glowSphere(0.18, '#ff9a2e');
      case 'o': return glowSphere(0.16, '#ffe36b', 2);
      case 'M': return glowSphere(0.45, '#ff6a1a', 2.4);
      case 'm': return propOr('mine', () => new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.25, 0.1, 12), new THREE.MeshStandardMaterial({ color: '#2a2f36', emissive: '#2fd6c8' })));
      case 'c': return propOr('canister', () => new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.3, 10), new THREE.MeshStandardMaterial({ color: '#7a2a24' })));
      case 't': {
        const obj = propOr('turret', () => {
          const g = new THREE.Group();
          g.add(new THREE.Mesh(new THREE.SphereGeometry(0.35, 12, 8), new THREE.MeshStandardMaterial({ color: '#3d4a33' })));
          g.children[0].position.y = 0.6;
          return g;
        });
        obj.traverse((o) => {
          if (o.isMesh && o.material.name === 'Team') { o.material.color.set(tc); if (o.material.emissive) o.material.emissive.set(tc); }
        });
        return obj;
      }
      case 'f': {
        const g = new THREE.Group();
        const disc = new THREE.Mesh(new THREE.CircleGeometry(extra, 40).rotateX(-Math.PI / 2),
          new THREE.MeshBasicMaterial({ color: '#ff5a10', transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
        disc.position.y = 0.05;
        const wall = new THREE.Mesh(new THREE.CylinderGeometry(extra, extra * 0.9, 1.6, 40, 1, true),
          new THREE.ShaderMaterial({
            transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
            uniforms: { time: { value: 0 } },
            vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
            fragmentShader: `uniform float time; varying vec2 vUv;
              void main(){ float f = sin(vUv.x * 40.0 + time * 6.0) * 0.5 + 0.5; float a = pow(1.0 - vUv.y, 1.5) * (0.35 + 0.4 * f);
              gl_FragColor = vec4(vec3(1.0, 0.45 + 0.3 * f, 0.1) * a, a); }`,
          }));
        wall.position.y = 0.8;
        g.add(disc, wall);
        g.userData.anim = (t) => { wall.material.uniforms.time.value = t; };
        return g;
      }
      case 's': {
        const g = new THREE.Group();
        const dome = new THREE.Mesh(new THREE.SphereGeometry(extra, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2),
          new THREE.ShaderMaterial({
            transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
            uniforms: { color: { value: new THREE.Color('#ffd76a') }, time: { value: 0 } },
            vertexShader: 'varying vec3 vN; varying vec3 vV; varying float vY; void main(){ vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position,1.0); vV = normalize(-mv.xyz); vY = position.y; gl_Position = projectionMatrix * mv; }',
            fragmentShader: `uniform vec3 color; uniform float time; varying vec3 vN; varying vec3 vV; varying float vY;
              void main(){ float rim = pow(1.0 - abs(dot(vN, vV)), 2.0); float band = 0.5 + 0.5 * sin(vY * 6.0 - time * 3.0);
              float a = 0.08 + rim * 0.5 + band * 0.05; gl_FragColor = vec4(color * a, a); }`,
          }));
        g.add(dome);
        const ring = new THREE.Mesh(new THREE.RingGeometry(extra - 0.15, extra, 48).rotateX(-Math.PI / 2),
          new THREE.MeshBasicMaterial({ color: tc, transparent: true, opacity: 0.8, depthWrite: false }));
        ring.position.y = 0.06;
        g.add(ring);
        g.userData.anim = (t) => { dome.material.uniforms.time.value = t; };
        return g;
      }
      default:
        return new THREE.Group();
    }
  }

  // list: [{ id, type, x, y, z, team, extra }] (보간된 위치)
  syncEntities(list, dt) {
    this.time += dt;
    const seen = new Set();
    for (const e of list) {
      seen.add(e.id);
      let rec = this.ents.get(e.id);
      if (!rec) {
        rec = { obj: this.makeEntity(e.type, e.team, e.extra), type: e.type };
        this.scene.add(rec.obj);
        this.ents.set(e.id, rec);
      }
      const o = rec.obj;
      o.position.set(e.x, e.y, e.z);
      if (e.type === 'c') { o.rotation.x += dt * 9; o.rotation.z += dt * 5; }
      if (e.type === 't') (o.getObjectByName('head') || o).rotation.y = e.extra;
      if (e.type === 'm') o.visible = e.extra ? Math.sin(this.time * 10) > -0.6 : true;
      if (o.userData.anim) o.userData.anim(this.time);
    }
    for (const [id, rec] of this.ents) {
      if (!seen.has(id)) {
        this.scene.remove(rec.obj);
        // GLB 소품은 지오메트리를 원본과 공유하므로 머티리얼만 해제한다
        const sharedGeo = rec.type === 'm' || rec.type === 'c' || rec.type === 't';
        rec.obj.traverse((o) => {
          if (o.isMesh) {
            if (!sharedGeo) o.geometry.dispose();
            o.material.dispose();
          }
        });
        this.ents.delete(id);
      }
    }
    this.pointWall.material.uniforms.time.value = this.time;
    for (const p of this.packs) {
      p.rotation.y += dt * 1.5;
      p.position.y += Math.sin(this.time * 2 + p.id) * 0.002;
    }
  }
}
