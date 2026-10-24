// Foto modu: o anki bakıştan ışın izlemeli (path tracing) kare. Işık pencerelerden gökyüzünden ve
// güneşten gelir, duvarlardan/tavandan seker; bekledikçe gürültü azalır. Ayrı parça olarak yüklenir.
// Kütüphane: three-gpu-pathtracer (MIT). Yalnızca MeshStandard/Physical malzemeler desteklenir.

import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { DenoiseMaterial, ProceduralEquirectTexture, WebGLPathTracer } from 'three-gpu-pathtracer';
import { PICK_LAYER } from './furniture.js';

const MAX_SAMPLES = 600;

/** Gökyüzü ortam dokusu (güneş diski yok; doğrudan güneşi yönlü ışık verir). */
function skyTexture(day) {
  const t = new ProceduralEquirectTexture(256, 128);
  // Doygunluğu düşük tutulur: göz/kamera beyaz dengesi yapar, iç mekân maviye kaçmasın.
  const zenith = new THREE.Color(0xb7cbe8).multiplyScalar(0.05 + 0.95 * day);
  const horizon = new THREE.Color(0xf1f3f6).multiplyScalar(0.04 + 0.96 * day);
  const ground = new THREE.Color(0x77736a).multiplyScalar(0.03 + 0.5 * day);
  const dir = new THREE.Vector3();
  t.generationCallback = (polar, uv, coord, color) => {
    dir.setFromSpherical(polar);
    if (dir.y >= 0) color.lerpColors(horizon, zenith, dir.y ** 0.55);
    else color.lerpColors(horizon, ground, Math.min(1, -dir.y * 6));
  };
  t.update();
  return t;
}

export class PhotoMode {
  constructor(viewer) {
    this.v = viewer;
    this.restore = [];
  }

  _set(obj, key, value) {
    this.restore.push([obj, key, obj[key]]);
    obj[key] = value;
  }

  start() {
    const v = this.v;
    const scene = v.scene;
    // Analiz katmanları, etiketler, görünmez seçim kutuları ve gökyüzü kabuğu fotoğrafa girmez.
    for (const o of [v.overlay, v.overlayLabels, v.furniture.zones, v.furniture.labels, v.house.planMarks, v.house.aboveMarks, v.marker, v.tape?.group].filter(Boolean))
      this._set(o, 'visible', false);
    for (const m of v.furniture.meshes.values()) if (m.body.layers.mask === 1 << PICK_LAYER) this._set(m.body, 'visible', false);
    const dl = v.daylight;
    const day = dl?.day ?? 1;
    // Pencerelerdeki alan ışıkları "ışık kapısı" olarak kalır: gök ışığı odaya bunlardan örneklenir
    // (yalnızca ortam dokusuyla iç mekân çok yavaş netleşir). Ortam dokusu camdan görünen gökyüzü ve
    // hafif dolgu içindir.
    if (dl) this._set(dl.sky, 'visible', false);
    this._set(v.hemi, 'visible', false);
    this.sky = skyTexture(day);
    this._set(scene, 'environment', this.sky);
    this._set(scene, 'background', this.sky);
    this._set(scene, 'environmentIntensity', dl ? 0.35 : 1);
    this._set(scene, 'fog', null);
    this._set(v.renderer, 'toneMappingExposure', 1.05);

    // Kütüphane birleştirirken her parçaya tek malzeme sırası verir; malzeme dizili parçalar (duvarın
    // kesit üstü, ankastrenin ön yüzü) sonraki tüm parçaların malzemesini kaydırır. Fotoğraf süresince
    // bunlar her yüz grubu için ayrı, tek malzemeli geçici parçalara bölünür.
    const multi = [];
    scene.traverseVisible((o) => o.isMesh && Array.isArray(o.material) && multi.push(o));
    this.temp = [];
    for (const o of multi) {
      const geo = o.geometry;
      for (const grp of geo.groups) {
        const mat = o.material[grp.materialIndex];
        if (!mat || !geo.index) continue;
        const g = new THREE.BufferGeometry();
        for (const k of Object.keys(geo.attributes)) g.setAttribute(k, geo.attributes[k]);
        g.setIndex(new THREE.BufferAttribute(geo.index.array.slice(grp.start, grp.start + grp.count), 1));
        const m = new THREE.Mesh(g, mat);
        m.position.copy(o.position);
        m.quaternion.copy(o.quaternion);
        m.scale.copy(o.scale);
        o.parent.add(m);
        this.temp.push(m);
      }
      this._set(o, 'visible', false);
    }

    const pt = new WebGLPathTracer(v.renderer);
    const dpr = v.renderer.getPixelRatio();
    pt.renderScale = Math.min(1, 1.25 / dpr);
    pt.tiles.set(2, 2); // her karede dörtte bir: telefon donmadan çalışsın
    pt.bounces = 6;
    pt.minSamples = 1;
    pt.fadeDuration = 300;
    pt.filterGlossyFactor = 0.5;
    // Erken örneklerde gürültüyü kenarları koruyan bir bulanıklaştırmayla yumuşat; örnek arttıkça azalt.
    const denoise = new DenoiseMaterial({ map: null, premultipliedAlpha: v.renderer.getContextAttributes().premultipliedAlpha });
    const dq = new FullScreenQuad(denoise);
    pt.renderToCanvasCallback = (target, renderer, quad) => {
      const n = Math.max(1, pt.samples);
      denoise.map = target.texture;
      denoise.opacity = quad.material.opacity;
      denoise.sigma = n < 400 ? 2.5 : 1.2;
      denoise.kSigma = 1.5;
      denoise.threshold = Math.max(0.02, 0.35 / Math.sqrt(n));
      const ac = renderer.autoClear;
      renderer.autoClear = false;
      dq.render(renderer);
      renderer.autoClear = ac;
    };
    this.denoise = { material: denoise, quad: dq };
    pt.setScene(scene, v.perspCam);
    this.pt = pt;
  }

  /** Bir örnek çizer; döner: toplam örnek sayısı. Üst sınıra ulaşınca durur (pil için). */
  render() {
    const pt = this.pt;
    pt.pausePathTracing = pt.samples >= MAX_SAMPLES;
    pt.renderSample();
    return Math.floor(pt.samples);
  }

  get done() {
    return this.pt.samples >= MAX_SAMPLES;
  }

  /** Kamera/pencere boyutu değişti. */
  reset() {
    this.pt.updateCamera();
  }

  /** Görüntüyü PNG olarak verir (son çizilen kare). */
  snapshot() {
    return this.v.renderer.domElement.toDataURL('image/png');
  }

  stop() {
    this.pt?.dispose();
    this.denoise?.quad.dispose();
    this.denoise?.material.dispose();
    this.sky?.dispose();
    for (const [obj, key, value] of this.restore.reverse()) obj[key] = value;
    this.restore = [];
    for (const m of this.temp ?? []) {
      m.removeFromParent();
      m.geometry.dispose();
    }
    this.temp = [];
  }
}
