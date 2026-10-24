// Gün ışığı (HD, 3D ve yürü): evin konumuna ve cephe yönüne göre güneş (gölgeli), Preetham gökyüzü,
// pencerelerden giren gök ışığı (her duvardaki camlar için bir alan ışığı) ve akşam sarkıt lambalar.
// Konum ve kuzey yönü plan.json "site" alanından; yoksa İstanbul saati ve plan +x = kuzey varsayılır.

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { sunPosition, sunVector, sunlitRooms, windowFacades } from '../core/sun.js';
import { CM, v3 } from './house.js';

const SKY_LIGHT = new THREE.Color(0xe6edf6);
const smooth = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class Daylight {
  constructor(scene, model, sun, hemi) {
    RectAreaLightUniformsLib.init();
    this.model = model;
    this.site = model.plan.site ?? { lat: 41.01, lon: 28.98, utcOffset: 3, northAngle: 0, assumed: true };
    this.sun = sun;
    this.hemi = hemi;
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);

    const sky = new Sky();
    sky.scale.setScalar(150);
    Object.assign(sky.material.uniforms.turbidity, { value: 3 });
    Object.assign(sky.material.uniforms.rayleigh, { value: 1.2 });
    sky.material.uniforms.cloudCoverage.value = 0.25;
    sky.frustumCulled = false;
    this.sky = sky;
    this.group.add(sky);

    // Dışarıda zemin (bina bulunduğu kattan aşağıda; görsel).
    const ground = new THREE.Mesh(new THREE.CircleGeometry(140, 48), new THREE.MeshStandardMaterial({ color: 0x8d9a7d, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -12;
    this.ground = ground;
    this.group.add(ground);

    // Pencereler: aynı duvardaki camlar tek alan ışığında birleşir; ışık oda tarafına bakar.
    this.facades = windowFacades(model);
    this.windows = [];
    for (const f of this.facades) {
      const light = new THREE.RectAreaLight(SKY_LIGHT, 0, (f.s1 - f.s0) * CM, (f.z1 - f.z0) * CM);
      const p = f.at(f.face + f.sg * 2);
      const q = f.at(f.face + f.sg * 200);
      light.position.copy(v3(p[0], p[1], (f.z0 + f.z1) / 2));
      light.lookAt(v3(q[0], q[1], (f.z0 + f.z1) / 2));
      light.userData.facade = f;
      this.windows.push(light);
      this.group.add(light);
    }

    // Sarkıt lambalar (akşam yanar).
    this.lamps = [];
    for (const f of model.fixtures) {
      if (f.type !== 'lamp') continue;
      const l = new THREE.PointLight(0xffd8a8, 0, 9, 2);
      l.position.copy(v3(f.x, f.y, f.z + f.h * 0.4));
      this.lamps.push(l);
      this.group.add(l);
    }
  }

  /** Saati ve tarihi uygular. date: { y, m, d, hour }. */
  set(date) {
    const S = this.site;
    this.date = date;
    this.pos = sunPosition(date, S.lat, S.lon, S.utcOffset ?? 3);
    const [x, y, z] = sunVector(this.pos, S.northAngle ?? 0);
    const dir = new THREE.Vector3(x, z, y).normalize();
    this.dir = dir;
    this.sky.material.uniforms.sunPosition.value.copy(dir);
    const el = this.pos.elevation;
    const day = smooth(-6, 8, el); // alacakaranlıktan güne
    const high = smooth(5, 35, el);
    this.day = day;

    // Güneş: alçakken sıcak ve zayıf, ufkun altında kapalı.
    const warm = new THREE.Color(0xff9a5a).lerp(new THREE.Color(0xfff3e2), high);
    this.sun.color.copy(warm);
    this.sun.intensity = 3.2 * smooth(-1, 6, el) * (0.55 + 0.45 * high);
    this.sunDir = dir;

    // Gök ışığı pencerelerden: gündüz güçlü; güneşin vurduğu cephede biraz daha parlak.
    const sunH = [x, y];
    for (const l of this.windows) {
      const o = l.userData.facade.outward;
      const facing = Math.max(0, o[0] * sunH[0] + o[1] * sunH[1]);
      l.intensity = day * (3.2 + 2 * facing * high);
      l.color.copy(SKY_LIGHT).lerp(new THREE.Color(0xffd2a8), (1 - high) * day * 0.5);
    }
    this.hemi.color.setHex(0xeef3fb);
    this.hemi.groundColor.setHex(0x9a8f80);
    this.hemi.intensity = 0.15 + 0.65 * day;
    for (const l of this.lamps) l.intensity = (1 - day) * 3.5;
    this.ground.material.color.setHex(0x8d9a7d).multiplyScalar(0.25 + 0.75 * day);
    return this.pos;
  }

  /** Şu an doğrudan güneş alan odalar. */
  sunlitRooms() {
    return sunlitRooms(this.facades, this.pos, this.site.northAngle ?? 0);
  }

  /** Gölge kamerası: evin tamamını güneş yönünden kapsayacak şekilde. */
  placeSun(center, extent) {
    const d = this.dir ?? new THREE.Vector3(0.3, 0.8, 0.2);
    this.sun.position.copy(center).addScaledVector(d, extent * 2);
    this.sun.target.position.copy(center);
    const half = extent * 0.72;
    Object.assign(this.sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 0.1, far: extent * 4 });
    this.sun.shadow.camera.updateProjectionMatrix();
  }

  /** Gökyüzü kamerayla birlikte hareket eder (uzak düzlemin içinde kalsın). */
  follow(camera) {
    this.sky.position.copy(camera.position);
  }

  /** outside: gökyüzü, dış zemin ve uzak pus (yürürken). 3D'de ev nötr zeminde, yalnızca ışıklar. */
  setEnabled(on, outside = on) {
    this.group.visible = on;
    for (const l of [...this.windows, ...this.lamps]) l.visible = on;
    this.sky.visible = this.ground.visible = outside;
    this.outside = outside;
  }
}
