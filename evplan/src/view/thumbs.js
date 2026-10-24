// Katalog küçük görselleri: her ürünün kendi 3D modelinden (ya da kutusundan) ekran dışı çizim.
// Tek bir küçük WebGL bağlamı kullanılır; sonuçlar data URL olarak önbelleklenir.

import * as THREE from 'three';
import { resolveItem } from '../core/items.js';
import { buildModel } from './models/index.js';

const W = 192;
const H = 128;
let ctx = null;
const cache = new Map();
const queue = [];
let busy = false;

function setup() {
  if (ctx) return ctx;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H);
  renderer.toneMapping = THREE.NeutralToneMapping;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb8b2aa, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(2, 4, 3);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(30, W / H, 0.05, 50);
  ctx = { renderer, scene, camera };
  return ctx;
}

function render(it) {
  const { renderer, scene, camera } = setup();
  let obj = buildModel(it);
  if (!obj) {
    obj = new THREE.Mesh(
      new THREE.BoxGeometry(it.w / 100, Math.max(it.h, 1) / 100, it.d / 100),
      new THREE.MeshLambertMaterial({ color: new THREE.Color(it.color) }),
    );
    obj.position.y = Math.max(it.h, 1) / 200;
  }
  const holder = new THREE.Group();
  holder.add(obj);
  holder.rotation.y = -0.55;
  scene.add(holder);
  const box = new THREE.Box3().setFromObject(holder);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const r = Math.max(size.x, size.y * 1.4, size.z) * 1.15;
  const dist = r / (2 * Math.tan((camera.fov * Math.PI) / 360)) / Math.min(1, camera.aspect) + r * 0.2;
  camera.position.set(center.x, center.y + dist * 0.35, center.z + dist);
  camera.lookAt(center);
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL('image/png');
  scene.remove(holder);
  holder.traverse((o) => {
    o.geometry?.dispose();
  });
  return url;
}

const idle = (fn) => (window.requestIdleCallback ? window.requestIdleCallback(fn, { timeout: 300 }) : setTimeout(fn, 1));

function pump() {
  if (busy || !queue.length) return;
  busy = true;
  const run = () => {
    const job = queue.shift();
    if (job) {
      try {
        const url = cache.get(job.key) ?? render(job.it);
        cache.set(job.key, url);
        job.cb(url);
      } catch {
        /* WebGL yoksa küçük görsel atlanır */
      }
    }
    busy = false;
    if (queue.length) idle(pump);
  };
  idle(run);
}

/** Katalog ürününün küçük görselini ister; hazır olunca cb(dataUrl) çağrılır. */
export function requestThumb(catalogItem, choice, cb) {
  const it = resolveItem({ uid: 'thumb', ref: catalogItem.id, x: 0, y: 0, rot: 0, choice }, new Map([[catalogItem.id, catalogItem]]));
  const key = `${catalogItem.id}|${JSON.stringify(it.parts ?? {})}`;
  if (cache.has(key)) return cb(cache.get(key));
  queue.push({ key, it, cb });
  pump();
}
