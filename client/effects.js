// 일회성 시각 효과: 탄도선, 총구 섬광, 폭발, 파동 고리, 지정 표식.
import * as THREE from 'three';

const tmp = new THREE.Vector3();

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.items = [];
    this.tracerMat = new THREE.MeshBasicMaterial({ color: 0xfff1c4, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
    this.tracerGeo = new THREE.CylinderGeometry(0.012, 0.012, 1, 4, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5);
    this.sphereGeo = new THREE.SphereGeometry(1, 16, 12);
    this.ringGeo = new THREE.RingGeometry(0.92, 1, 48).rotateX(-Math.PI / 2);
    this.discGeo = new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2);
    this.sparkGeo = new THREE.BufferGeometry();
    // 동적 조명은 비용이 크므로 몇 개만 돌려 쓴다
    this.lights = [];
    for (let i = 0; i < 4; i++) {
      const l = new THREE.PointLight(0xffaa55, 0, 8, 2);
      l.userData.t = 0;
      scene.add(l);
      this.lights.push(l);
    }
    this.lightIdx = 0;
  }

  flashLight(pos, color, intensity, dist, dur) {
    const l = this.lights[this.lightIdx++ % this.lights.length];
    l.position.copy(pos);
    l.color.set(color);
    l.distance = dist;
    l.userData = { t: dur, dur, intensity };
    l.intensity = intensity;
  }

  add(obj, life, update) {
    this.scene.add(obj);
    this.items.push({ obj, life, age: 0, update });
  }

  tracer(from, to, color = 0xfff1c4, width = 1) {
    const len = from.distanceTo(to);
    if (len < 0.05) return;
    const mat = this.tracerMat.clone();
    mat.color.set(color);
    const m = new THREE.Mesh(this.tracerGeo, mat);
    m.position.copy(from);
    m.scale.set(width, width, len);
    m.lookAt(to);
    this.add(m, 0.12, (it, f) => { mat.opacity = 0.9 * (1 - f); });
  }

  muzzle(pos, color = 0xffd27a) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const m = new THREE.Mesh(this.sphereGeo, mat);
    m.position.copy(pos);
    m.scale.setScalar(0.09);
    this.add(m, 0.06, (it, f) => { mat.opacity = 1 - f; m.scale.setScalar(0.09 + f * 0.08); });
    this.flashLight(pos, color, 6, 6, 0.06);
  }

  impact(pos, color = 0xffe0a0) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const m = new THREE.Mesh(this.sphereGeo, mat);
    m.position.copy(pos);
    m.scale.setScalar(0.06);
    this.add(m, 0.15, (it, f) => { mat.opacity = 1 - f; m.scale.setScalar(0.06 + f * 0.12); });
  }

  explosion(pos, radius, color = 0xff8a2a) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const core = new THREE.Mesh(this.sphereGeo, mat);
    core.position.copy(pos);
    this.add(core, 0.45, (it, f) => {
      core.scale.setScalar(radius * (0.3 + 0.8 * Math.sqrt(f)));
      mat.opacity = 0.85 * (1 - f) * (1 - f);
    });
    this.sparks(pos, color, Math.round(14 + radius * 6), 4 + radius * 2.2);
    this.flashLight(pos, color, 30, radius * 5, 0.25);
  }

  sparks(pos, color, count, speed) {
    const positions = new Float32Array(count * 3);
    const vel = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = pos.x; positions[i * 3 + 1] = pos.y; positions[i * 3 + 2] = pos.z;
      tmp.set(Math.random() * 2 - 1, Math.random() * 1.6 - 0.3, Math.random() * 2 - 1).normalize().multiplyScalar(speed * (0.4 + Math.random() * 0.6));
      vel[i * 3] = tmp.x; vel[i * 3 + 1] = tmp.y; vel[i * 3 + 2] = tmp.z;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({ color, size: 0.12, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const pts = new THREE.Points(geo, mat);
    this.add(pts, 0.7, (it, f, dt) => {
      const a = geo.attributes.position.array;
      for (let i = 0; i < count; i++) {
        vel[i * 3 + 1] -= 12 * dt;
        a[i * 3] += vel[i * 3] * dt; a[i * 3 + 1] += vel[i * 3 + 1] * dt; a[i * 3 + 2] += vel[i * 3 + 2] * dt;
      }
      geo.attributes.position.needsUpdate = true;
      mat.opacity = 1 - f;
    });
    pts.userData.dispose = () => geo.dispose();
  }

  ring(pos, radius, color, life = 0.6) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const m = new THREE.Mesh(this.ringGeo, mat);
    m.position.copy(pos).add(tmp.set(0, 0.08, 0));
    this.add(m, life, (it, f) => { m.scale.setScalar(Math.max(0.01, radius * f)); mat.opacity = 1 - f; });
  }

  // 유성 낙하 지점 표시
  marker(pos, radius, color, life) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.25, depthWrite: false, side: THREE.DoubleSide });
    const disc = new THREE.Mesh(this.discGeo, mat);
    disc.position.copy(pos).add(tmp.set(0, 0.06, 0));
    disc.scale.setScalar(radius);
    this.add(disc, life, (it, f) => { mat.opacity = 0.18 + 0.15 * Math.sin(it.age * 14); if (f > 0.9) mat.opacity *= (1 - f) * 10; });
  }

  update(dt) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.age += dt;
      const f = Math.min(1, it.age / it.life);
      if (it.update) it.update(it, f, dt);
      if (it.age >= it.life) {
        this.scene.remove(it.obj);
        if (it.obj.material) it.obj.material.dispose();
        if (it.obj.userData.dispose) it.obj.userData.dispose();
        this.items.splice(i, 1);
      }
    }
    for (const l of this.lights) {
      const u = l.userData;
      if (u.t > 0) {
        u.t -= dt;
        l.intensity = Math.max(0, (u.t / u.dur) * u.intensity);
      } else if (l.intensity) {
        l.intensity = 0;
      }
    }
  }
}
