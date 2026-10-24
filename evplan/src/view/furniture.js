// Mobilya görselleri: kutu (G×D×Y) ya da bağlanmış GLB modeli, ön yüz işareti, durum renkleri,
// kapak/çekmece/kullanım alanları.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CM, label, polyFill, polyLine, v3 } from './house.js';
import { drawerZones, frontLeaves, leafPolygon, useZones } from '../core/items.js';
import { buildModel } from './models/index.js';

const unitBox = new THREE.BoxGeometry(1, 1, 1);
unitBox.translate(0, 0.5, 0);
const edgeGeo = new THREE.EdgesGeometry(unitBox);

/** Görünmez seçim kutusunun katmanı: kamera, gölge ve AO görmez; yalnızca seçim ışını görür. */
export const PICK_LAYER = 2;

const STATE_EDGE = { error: 0xdc2626, warn: 0xd97706, selected: 0x2563eb, none: 0x374151 };

const loader = new GLTFLoader();
const modelCache = new Map();

function loadModel(url) {
  if (!modelCache.has(url)) {
    modelCache.set(
      url,
      new Promise((resolve, reject) => loader.load(url, (g) => resolve(g.scene), undefined, reject)),
    );
  }
  return modelCache.get(url);
}

/** GLB'yi verilen G×Y×D kutusuna oturtur (ölçü doğruluğu için eksen başına ölçek). */
function fitModel(scene, it) {
  const obj = scene.clone(true);
  if (it.modelRotation) obj.rotation.y = (it.modelRotation * Math.PI) / 180;
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const wrap = new THREE.Group();
  wrap.add(obj);
  obj.position.sub(new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2));
  wrap.scale.set((it.w * CM) / (size.x || 1), (it.h * CM) / (size.y || 1), (it.d * CM) / (size.z || 1));
  return wrap;
}

export class FurnitureView {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'furniture';
    this.zones = new THREE.Group();
    this.labels = new THREE.Group();
    scene.add(this.group, this.zones, this.labels);
    this.meshes = new Map(); // uid → { root, body, edges, label, key }
    this.showZones = true;
  }

  key(it) {
    return [it.w, it.d, it.h, it.color, it.model, it.name, JSON.stringify(it.parts ?? null), it.shape?.type, it.modules?.length].join('|');
  }

  sync(items, state, selection) {
    const seen = new Set();
    for (const it of items) {
      seen.add(it.uid);
      let m = this.meshes.get(it.uid);
      if (!m || m.key !== this.key(it)) {
        if (m) this._dispose(m);
        m = this._create(it);
        this.meshes.set(it.uid, m);
      }
      m.root.position.copy(v3(it.x, it.y, it.z));
      m.root.rotation.y = (-it.rot * Math.PI) / 180;
      m.label.position.copy(v3(it.x, it.y, it.z + it.h + 3));
      const st = selection === it.uid ? 'selected' : (state.get(it.uid) ?? 'none');
      m.edges.material.color.setHex(STATE_EDGE[st]);
      m.edges.visible = !m.shaped || st !== 'none';
      const emissive = st === 'error' ? 0x7f1d1d : st === 'selected' ? 0x1e3a8a : 0x000000;
      m.body.material.emissive.setHex(emissive);
      m.body.material.emissiveIntensity = st === 'none' ? 0 : 0.35;
      if (m.shaped && m.root.userData.st !== st) {
        // Modelli mobilyada durum rengi hafif bir parıltı olarak verilir.
        m.root.userData.st = st;
        m.root.traverse((o) => {
          if (o.isMesh && o !== m.body && o.material?.emissive) {
            if (!o.userData.mat) o.userData.mat = o.material;
            o.material = st === 'none' ? o.userData.mat : o.userData.mat.clone();
            if (st !== 'none') {
              o.material.emissive.setHex(emissive || 0x7c2d12);
              o.material.emissiveIntensity = 0.18;
            }
          }
        });
      }
      m.label.element.classList.toggle('sel', st === 'selected');
    }
    for (const [uid, m] of this.meshes) {
      if (seen.has(uid)) continue;
      this._dispose(m);
      this.meshes.delete(uid);
    }
    this.drawZones(items, selection);
  }

  _create(it) {
    const root = new THREE.Group();
    root.userData.uid = it.uid;
    const color = new THREE.Color(it.color);
    const body = new THREE.Mesh(
      unitBox,
      new THREE.MeshStandardMaterial({ color, roughness: 0.8, transparent: !it.collides, opacity: it.collides ? 1 : 0.7 }),
    );
    body.scale.set(it.w * CM, Math.max(it.h, 0.5) * CM, it.d * CM);
    body.userData.uid = it.uid;
    body.castShadow = it.collides;
    body.receiveShadow = true;
    root.add(body);
    const edges = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: STATE_EDGE.none }));
    edges.scale.copy(body.scale);
    root.add(edges);
    // Parametrik model (koltuk, TV ünitesi…): kutu görünmez kalır ama seçim için tıklanabilir.
    const model = buildModel(it);
    if (model) {
      model.traverse((o) => {
        if (o.isMesh) o.userData.uid = it.uid;
      });
      root.add(model);
      Object.assign(body.material, { transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
      body.layers.set(PICK_LAYER);
    }
    // Ön yüz işareti: üst yüzün ön kenarında koyu şerit.
    if (!model && it.collides && it.h > 5) {
      const strip = new THREE.Mesh(unitBox, new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(0.45) }));
      const depth = Math.min(8, it.d * 0.2);
      strip.scale.set(it.w * CM * 0.9, 0.004, depth * CM);
      strip.position.set(0, it.h * CM + 0.001, (it.d / 2 - depth / 2) * CM);
      root.add(strip);
    }
    if (it.model) {
      loadModel(it.model)
        .then((scene) => {
          const fitted = fitModel(scene, it);
          fitted.traverse((o) => {
            if (o.isMesh) o.userData.uid = it.uid;
          });
          root.add(fitted);
          Object.assign(body.material, { transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
          body.layers.set(PICK_LAYER);
        })
        .catch(() => {
          /* model yüklenemezse kutu kalır */
        });
    }
    const lbl = label(it.name, 'item', v3(0, 0, 0));
    this.group.add(root);
    this.labels.add(lbl);
    return { root, body, edges, label: lbl, key: this.key(it), shaped: !!model };
  }

  _dispose(m) {
    this.group.remove(m.root);
    this.labels.remove(m.label);
    m.label.element.remove();
    m.body.material.dispose();
    m.edges.material.dispose();
  }

  pickables() {
    const out = [];
    for (const m of this.meshes.values()) m.root.traverse((o) => o.isMesh && out.push(o));
    return out;
  }

  drawZones(items, selection) {
    for (const c of [...this.zones.children]) {
      this.zones.remove(c);
      c.geometry?.dispose();
      c.material?.dispose();
    }
    if (!this.showZones) return;
    for (const it of items) {
      const sel = it.uid === selection;
      if (this.zonesSelectedOnly && !sel) continue; // yürürken yalnızca seçili mobilyanın kapak/çekmece izleri
      for (const leaf of frontLeaves(it)) {
        const poly = leafPolygon(leaf, 12);
        this.zones.add(polyLine(poly.slice(1), 0.01, 0x6b7280, { closed: false, dashed: true, opacity: sel ? 1 : 0.6 }));
        if (sel) this.zones.add(polyFill(poly, 0.008, 0x2563eb, 0.12));
      }
      for (const { poly: dz } of drawerZones(it)) this.zones.add(polyLine(dz, 0.01, 0x6b7280, { dashed: true, opacity: sel ? 1 : 0.5 }));
      if (sel)
        for (const z of useZones(it)) {
          this.zones.add(polyFill(z.poly, 0.006, 0x16a34a, 0.12));
          this.zones.add(polyLine(z.poly, 0.009, 0x16a34a, { dashed: true }));
        }
    }
  }
}
