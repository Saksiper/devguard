// Ana görüntüleyici: üç mod (plan / 3D / yürü), mobilya sürükleme-döndürme, kontrol katmanları.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { CM, applyCut, buildHouse, label, polyFill, polyLine, v3 } from './house.js';
import { FurnitureView } from './furniture.js';
import { WalkControls } from './walk.js';
import { buildObstacles, itemDistances, sideDistance } from '../core/checks.js';
import { footprint, sideFrame } from '../core/items.js';
import { normAngle } from '../core/geom.js';

const PLAN_CUT = 120; // plan görünümünde duvar kesit yüksekliği (cm), mimari plan gibi
const ORBIT_CUT = 120;

export class Viewer extends EventTarget {
  constructor(container, store, model) {
    super();
    this.container = container;
    this.store = store;
    this.model = model;
    this.mode = 'plan';
    this.orbitCut = true;
    this.showPaths = true;
    this.labelsOn = true;
    this.issues = [];
    this.passage = null;
    this.itemState = new Map();
    this.ghost = null;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0xe9e7e2);
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const labels = new CSS2DRenderer();
    labels.domElement.className = 'label-layer';
    Object.assign(labels.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
    container.appendChild(labels.domElement);
    this.labelRenderer = labels;

    this.scene = new THREE.Scene();
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xa8a29e, 2.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.3);
    sun.position.set(4, 10, 6);
    this.scene.add(sun);

    this.house = buildHouse(model);
    this.scene.add(this.house.root);
    this.furniture = new FurnitureView(this.scene);
    this.overlay = new THREE.Group();
    this.overlayLabels = new THREE.Group();
    this.scene.add(this.overlay, this.overlayLabels);

    const b = model.bounds;
    this.center = new THREE.Vector3(((b.minX + b.maxX) / 2) * CM, 0, ((b.minY + b.maxY) / 2) * CM);
    this.extent = Math.max(b.maxX - b.minX, b.maxY - b.minY) * CM;

    this.planCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    this.planCam.up.set(0, 0, -1);
    this.planCam.position.set(this.center.x, 30, this.center.z);
    this.planCam.lookAt(this.center);
    this.planCam.layers.enable(1);
    this.perspCam = new THREE.PerspectiveCamera(60, 1, 0.05, 200);
    this.perspCam.position.set(this.center.x + this.extent * 0.2, this.extent * 1.1, this.center.z + this.extent * 1.0);

    this.planControls = new OrbitControls(this.planCam, renderer.domElement);
    Object.assign(this.planControls, { enableRotate: false, screenSpacePanning: true, zoomToCursor: true });
    this.planControls.target.copy(this.center);
    this.planControls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.planControls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
    this.orbitControls = new OrbitControls(this.perspCam, renderer.domElement);
    this.orbitControls.target.copy(this.center);
    this.orbitControls.maxPolarAngle = Math.PI * 0.49;
    this.orbitControls.enableDamping = true;

    // Mini harita için oyuncu işareti (yalnızca plan kamerasının gördüğü katman).
    this.marker = new THREE.Mesh(
      new THREE.ConeGeometry(0.22, 0.6, 3).rotateX(Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x2563eb }),
    );
    this.marker.layers.set(1);
    this.scene.add(this.marker);

    this.walk = new WalkControls(renderer.domElement, document.getElementById('joystick'));
    this._placeWalker();

    this._bindPointer();
    this._resize();
    new ResizeObserver(() => this._resize()).observe(container);
    this.fit();
    this.setMode('plan');
    this.clock = new THREE.Timer();
    renderer.setAnimationLoop(() => this._frame());
  }

  _placeWalker() {
    const ent = this.model.entrance;
    if (ent) {
      const w = ent.wallRef;
      const side = ent.swing === 'left' ? 1 : ent.swing === 'right' ? -1 : -1;
      const face = side > 0 ? w.oMax : w.oMin;
      const p = [ent.center[0] + w.n[0] * (face + side * 60 - (w.oMin + w.oMax) / 2), ent.center[1] + w.n[1] * (face + side * 60 - (w.oMin + w.oMax) / 2)];
      const yaw = (Math.atan2(w.n[1] * side, w.n[0] * side) * 180) / Math.PI;
      this.walk.place(p, yaw);
    } else {
      const r = this.model.rooms[0];
      this.walk.place(r ? r.center : [0, 0], 0);
    }
  }

  _resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    this.aspect = w / h;
    this.perspCam.aspect = this.aspect;
    this.perspCam.updateProjectionMatrix();
    this._updatePlanFrustum();
  }

  _updatePlanFrustum() {
    const half = this.planHalf ?? this.extent * 0.6;
    const c = this.planCam;
    c.left = -half * this.aspect;
    c.right = half * this.aspect;
    c.top = half;
    c.bottom = -half;
    c.updateProjectionMatrix();
  }

  fit() {
    const b = this.model.bounds;
    const w = (b.maxX - b.minX) * CM;
    const h = (b.maxY - b.minY) * CM;
    // Telefonda alttaki kapalı panel (~64 px) sahnenin üstüne biner; ev görünen kısma ortalanır.
    const pad = window.matchMedia('(max-width: 760px)').matches ? 64 : 0;
    const H = this.container.clientHeight || 1;
    const avail = Math.max(1, H - pad);
    const visHalf = Math.max(h / 2, w / 2 / ((this.container.clientWidth || 1) / avail)) * 1.08;
    this.planHalf = (visHalf * H) / avail;
    const shift = (pad * this.planHalf) / H;
    this.planCam.zoom = 1;
    this.planControls.target.set(this.center.x, 0, this.center.z + shift);
    this.planCam.position.set(this.center.x, 30, this.center.z + shift);
    this._updatePlanFrustum();
    this.orbitControls.target.copy(this.center);
    this.perspCam.position.set(this.center.x + this.extent * 0.15, this.extent * 1.05, this.center.z + this.extent * 0.95);
    this.planControls.update();
    this.orbitControls.update();
  }

  setMode(mode) {
    this.mode = mode;
    const plan = mode === 'plan';
    const walk = mode === 'walk';
    this.planControls.enabled = plan;
    this.orbitControls.enabled = mode === 'orbit';
    this.walk.setEnabled(walk);
    applyCut(this.house, plan ? PLAN_CUT : mode === 'orbit' && this.orbitCut ? ORBIT_CUT : null);
    this.house.ceilings.visible = walk;
    this.house.planMarks.visible = !walk;
    this.house.aboveMarks.visible = plan;
    this.house.roomLabels.visible = plan;
    this.house.fixtureLabels.visible = plan;
    this.furniture.labels.visible = plan && this.labelsOn;
    this.marker.visible = walk;
    this.renderer.setClearColor(walk ? 0xdfe7ef : 0xe9e7e2);
    if (walk) this._updateWalkWorld();
    this.renderer.domElement.style.cursor = walk ? 'grab' : 'default';
    this.dispatchEvent(new CustomEvent('mode', { detail: mode }));
  }

  toggleCut() {
    this.orbitCut = !this.orbitCut;
    if (this.mode === 'orbit') applyCut(this.house, this.orbitCut ? ORBIT_CUT : null);
    return this.orbitCut;
  }

  get camera() {
    return this.mode === 'plan' ? this.planCam : this.perspCam;
  }

  _updateWalkWorld() {
    const obs = buildObstacles(this.model, this.store.items());
    const blocking = obs.all.filter((o) => o.z0 < 150 && o.z1 > 25 && !(o.kind === 'item' && o.movable));
    const walkable = [...this.model.rooms.map((r) => r.poly), ...this.model.doors.map((d) => d.portal)];
    this.walk.setWorld(blocking, walkable);
  }

  /** Mağaza değişince sahneyi günceller. */
  refresh() {
    this._labelsDirty = true;
    const items = this.store.items();
    this.furniture.sync(items, this.itemState, this.store.selection);
    this._drawOverlay();
    if (this.mode === 'walk') this._updateWalkWorld();
  }

  setChecks(result) {
    this.issues = result.issues;
    this.passage = result.passage;
    this.itemState = result.itemState;
    this.refresh();
  }

  setGhost(items) {
    this.ghost = items;
    this._drawOverlay();
  }

  _clearOverlay() {
    for (const c of [...this.overlay.children]) {
      this.overlay.remove(c);
      c.geometry?.dispose();
      c.material?.dispose();
    }
    for (const c of [...this.overlayLabels.children]) {
      this.overlayLabels.remove(c);
      c.element?.remove();
    }
  }

  _drawOverlay() {
    this._clearOverlay();
    const items = this.store.items();
    const sel = this.store.selection ? items.find((i) => i.uid === this.store.selection) : null;
    const labelH = this.mode === 'plan' ? 10 : 140;

    // Geçiş yolu: yalnızca hedefin altında kalanlar çizilir.
    if (this.showPaths && this.passage) {
      for (const r of this.passage.results) {
        if (!r.reachable || r.width >= r.threshold || r.skip) continue;
        const structural = r.baseWidth !== null && r.baseWidth - r.width < 2;
        const color = structural ? 0x2563eb : r.width < this.model.settings.passageHard ? 0xdc2626 : 0xd97706;
        if (r.path.length > 1) this.overlay.add(polyLine(r.path, 0.02, color, { closed: false, opacity: 0.85 }));
        const bn = r.bottleneck;
        const ring = [];
        for (let k = 0; k < 20; k++) {
          const a = (k / 20) * Math.PI * 2;
          ring.push([bn[0] + Math.cos(a) * (r.width / 2), bn[1] + Math.sin(a) * (r.width / 2)]);
        }
        this.overlay.add(polyLine(ring, 0.025, color));
        this.overlayLabels.add(label(`${Math.round(r.width)} cm`, 'dim', v3(bn[0], bn[1], labelH)));
      }
    }

    // Sorun işaretleri (numaralı).
    this.issues.forEach((is, i) => {
      if (!is.at || is.severity === 'info') return;
      const dy = is.kind === 'passage' ? -28 : 0;
      const lb = label(String(i + 1), `issue ${is.severity}`, v3(is.at[0], is.at[1] + dy, labelH + 20));
      this.overlayLabels.add(lb);
    });

    // Karşılaştırma hayaleti.
    if (this.ghost) {
      for (const it of this.ghost) this.overlay.add(polyLine(footprint(it), 0.03, 0x7c3aed, { dashed: true }));
    }

    // Seçili mobilya: kenarlardan en yakın engele ölçü çizgileri.
    if (sel && this.mode !== 'walk') {
      for (const d of itemDistances(this.model, items, sel)) {
        if (d.dist > 300) continue;
        this.overlay.add(polyLine([d.from, d.to], 0.03, 0x111827, { closed: false }));
        const mid = [(d.from[0] + d.to[0]) / 2, (d.from[1] + d.to[1]) / 2];
        this.overlayLabels.add(label(`${Math.round(d.dist)}`, 'dim', v3(mid[0], mid[1], labelH)));
      }
      this.overlay.add(polyFill(footprint(sel), (sel.z + sel.h) * CM + 0.004, 0x2563eb, 0.15));
    }
  }

  // ---- Etkileşim: seçme, sürükleme, iki parmakla döndürme ----
  _bindPointer() {
    const dom = this.renderer.domElement;
    const ray = new THREE.Raycaster();
    const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const ndc = new THREE.Vector2();
    const pointers = new Map();
    let drag = null;
    let down = null;

    const toPlan = (e) => {
      const r = dom.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, this.camera);
      const hit = new THREE.Vector3();
      if (!ray.ray.intersectPlane(floor, hit)) return null;
      return [hit.x / CM, hit.z / CM];
    };
    const pick = (e) => {
      const r = dom.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, this.camera);
      const hits = ray.intersectObjects(this.furniture.pickables(), false);
      if (!hits.length) return null;
      // Halı gibi çakışmayan katmanları en sona bırak.
      const sorted = hits
        .map((h) => ({ h, it: this.store.item(h.object.userData.uid) }))
        .filter((x) => x.it)
        .sort((a, b) => (a.it.collides === b.it.collides ? a.h.distance - b.h.distance : a.it.collides ? -1 : 1));
      return sorted[0]?.it ?? null;
    };
    const setControls = (on) => {
      if (this.mode === 'plan') this.planControls.enabled = on;
      if (this.mode === 'orbit') this.orbitControls.enabled = on;
    };

    // Yakalama aşamasında: OrbitControls olayı görmeden önce mobilyaya mı basıldı bakılır.
    this.container.addEventListener(
      'pointerdown',
      (e) => {
        if (this.mode === 'walk' && e.target === dom && this._miniTeleport(e)) {
          e.stopPropagation();
          return;
        }
        if (this.mode === 'walk' || e.target !== dom) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.tapeOn) {
          down = { x: e.clientX, y: e.clientY, t: performance.now() };
          return;
        }
        if (drag && pointers.size === 2) {
          // İkinci parmak: döndürme hareketi.
          const [a, b] = [...pointers.values()];
          drag.twist = { a0: Math.atan2(b.y - a.y, b.x - a.x), rot0: this.store.item(drag.uid)?.rot ?? 0 };
          e.stopPropagation();
          return;
        }
        down = { x: e.clientX, y: e.clientY, t: performance.now() };
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        const it = pick(e);
        if (!it) return;
        const p = toPlan(e);
        if (!p) return;
        this.store.select(it.uid);
        this.store.beginDrag();
        drag = { uid: it.uid, off: [it.x - p[0], it.y - p[1]], moved: false, id: e.pointerId };
        setControls(false);
        dom.setPointerCapture(e.pointerId);
        e.stopPropagation();
      },
      { capture: true },
    );

    dom.addEventListener('pointermove', (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!drag) return;
      if (drag.twist && pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        let rot = drag.twist.rot0 + ((ang - drag.twist.a0) * 180) / Math.PI;
        rot = Math.round(rot / 5) * 5;
        this.store.update(drag.uid, { rot: normAngle(rot) }, { live: true });
        drag.moved = true;
        return;
      }
      if (e.pointerId !== drag.id) return;
      const p = toPlan(e);
      if (!p) return;
      const it = this.store.item(drag.uid);
      if (!it) return;
      let x = Math.round(p[0] + drag.off[0]);
      let y = Math.round(p[1] + drag.off[1]);
      [x, y] = this.snap({ ...it, x, y }, e.altKey);
      if (x !== it.x || y !== it.y) {
        drag.moved = true;
        this.store.update(drag.uid, { x, y }, { live: true });
      }
    });

    const up = (e) => {
      pointers.delete(e.pointerId);
      if (drag) {
        if (drag.twist && pointers.size < 2) drag.twist = null;
        if (e.pointerId === drag.id || pointers.size === 0) {
          this.store.endDrag();
          drag = null;
          setControls(true);
        }
        return;
      }
      if (this.mode === 'walk' || !down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const tap = moved < 6 && performance.now() - down.t < 500 && e.target === dom;
      if (tap && this.tapeOn) this._tapeClick(e);
      else if (tap) this.store.select(null);
      down = null;
    };
    dom.addEventListener('pointerup', up);
    dom.addEventListener('pointercancel', up);
  }

  /** Yürü modunda mini plana dokununca oraya geç (ör. koridor ölçülmediyse odalar arası). */
  _miniTeleport(e) {
    const r = this.container.getBoundingClientRect();
    const w = r.width;
    const h = r.height;
    const size = Math.round(Math.min(w, h) * 0.32);
    const u = (e.clientX - r.left - (w - size - 10)) / size;
    const v = (e.clientY - r.top - (h - size - 10)) / size;
    if (u < 0 || u > 1 || v < 0 || v > 1) return false;
    const b = this.model.bounds;
    const half = (Math.max(b.maxX - b.minX, b.maxY - b.minY) / 2) * 1.05;
    const p = [this.center.x / CM + (u * 2 - 1) * half, this.center.z / CM + (v * 2 - 1) * half];
    if (this.walk._insideHome(p)) this.walk.pos = this.walk._resolve(p);
    return true;
  }

  setTape(on) {
    this.tapeOn = on;
    if (!this.tape) {
      this.tape = { group: new THREE.Group(), pts: [] };
      this.scene.add(this.tape.group);
    }
    this._clearTape();
    this.renderer.domElement.style.cursor = on ? 'crosshair' : 'default';
  }

  _clearTape() {
    const t = this.tape;
    for (const c of [...t.group.children]) {
      t.group.remove(c);
      c.element?.remove();
      c.geometry?.dispose();
    }
    t.pts = [];
  }

  /** Mezura: iki noktaya dokun → aradaki mesafe (planda yatay, 3D'de gerçek mesafe). */
  _tapeClick(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const targets = [...this.house.walls.children, ...this.house.fixtures.children, ...this.house.floors.children, ...this.furniture.pickables()].filter(
      (o) => o.visible && o.parent?.visible !== false,
    );
    const hit = ray.intersectObjects(targets, false)[0];
    if (!hit) return;
    const t = this.tape;
    if (t.pts.length >= 2) this._clearTape();
    const p = hit.point.clone();
    t.pts.push(p);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.03, 12, 8), new THREE.MeshBasicMaterial({ color: 0xdb2777, depthTest: false }));
    dot.position.copy(p);
    dot.renderOrder = 10;
    t.group.add(dot);
    if (t.pts.length === 2) {
      const [a, b] = t.pts;
      const flat = this.mode === 'plan';
      const d = flat ? Math.hypot(a.x - b.x, a.z - b.z) : a.distanceTo(b);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color: 0xdb2777, depthTest: false }));
      line.renderOrder = 10;
      t.group.add(line);
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const dx = Math.abs(a.x - b.x) / CM;
      const dz = Math.abs(a.z - b.z) / CM;
      const extra = dx > 1 && dz > 1 ? ` <small>(${Math.round(dx)} × ${Math.round(dz)})</small>` : '';
      t.group.add(label(`${Math.round(d / CM)} cm${extra}`, 'dim tape', mid));
    }
  }

  /** Mıknatıs: 6 cm'den yakın duvar/mobilya kenarına yapıştır (Alt basılıysa kapalı). */
  snap(it, off = false) {
    if (off) return [it.x, it.y];
    const obs = buildObstacles(this.model, this.store.items()).all.filter(
      (o) => o.uid !== it.uid && o.z0 < it.z + it.h && o.z1 > it.z,
    );
    let { x, y } = it;
    for (const side of ['front', 'back', 'left', 'right']) {
      const f = sideFrame({ ...it, x, y }, side);
      const { dist, obstacle } = sideDistance(f, obs, 7);
      if (obstacle && dist > 0.3 && dist < 6) {
        x += f.n[0] * (dist - 0.5);
        y += f.n[1] * (dist - 0.5);
      }
    }
    return [Math.round(x * 2) / 2, Math.round(y * 2) / 2];
  }

  /** Bir plan noktasına odaklan (sorun listesinden tıklanınca). */
  focus(p) {
    if (!p) return;
    if (this.mode === 'plan') {
      const delta = new THREE.Vector3(p[0] * CM, 0, p[1] * CM).sub(this.planControls.target);
      this.planControls.target.add(delta);
      this.planCam.position.add(delta);
      this.planCam.zoom = Math.max(this.planCam.zoom, 1.6);
      this.planCam.updateProjectionMatrix();
      this.planControls.update();
    } else if (this.mode === 'orbit') {
      const delta = new THREE.Vector3(p[0] * CM, 0, p[1] * CM).sub(this.orbitControls.target);
      this.orbitControls.target.add(delta);
      this.perspCam.position.add(delta);
      this.orbitControls.update();
    }
  }

  /** Ekranın ortasına denk gelen plan noktası (yeni mobilya buraya eklenir). */
  viewCenter() {
    const t = this.mode === 'plan' ? this.planControls.target : this.orbitControls.target;
    if (this.mode === 'walk') {
      const a = (this.walk.yaw * Math.PI) / 180;
      return [this.walk.pos[0] + Math.cos(a) * 120, this.walk.pos[1] + Math.sin(a) * 120];
    }
    return [t.x / CM, t.z / CM];
  }

  /** Plan görünümünde etiketleri ekrandaki boyuta göre göster/gizle (telefonda kalabalığı önler). */
  _updateLabels() {
    if (this.mode !== 'plan') return;
    const c = this.planCam;
    const pxPerCm = (this.container.clientHeight / ((c.top - c.bottom) / c.zoom)) * CM;
    if (Math.abs(pxPerCm - (this._lastPx ?? 0)) < 0.01 && !this._labelsDirty) return;
    this._lastPx = pxPerCm;
    this._labelsDirty = false;
    for (const [uid, m] of this.furniture.meshes) {
      const it = this.store.item(uid);
      if (!it) continue;
      const big = Math.max(it.w, it.d) * pxPerCm;
      const small = Math.min(it.w, it.d) * pxPerCm;
      const textW = it.name.length * 5.6 + 8;
      m.label.visible = it.collides && (uid === this.store.selection || (big > textW && small > 16));
    }
    for (const l of this.house.fixtureLabels.children) l.visible = pxPerCm > 1.1;
    for (const l of this.house.roomLabels.children) {
      const r = l.userData.room;
      const minPx = r ? Math.min(r.size[0], r.size[1]) * pxPerCm : 100;
      l.visible = minPx > 34;
      l.element.classList.toggle('compact', pxPerCm < 0.9 || minPx < 70);
    }
  }

  _frame() {
    this._updateLabels();
    this.clock.update();
    const dt = Math.min(0.05, this.clock.getDelta());
    if (this.mode === 'walk') {
      this.walk.update(dt);
      this.walk.applyToCamera(this.perspCam, this.model.settings.eyeHeight);
      this.marker.position.set(this.walk.pos[0] * CM, 2.7, this.walk.pos[1] * CM);
      this.marker.rotation.y = (-this.walk.yaw * Math.PI) / 180 - Math.PI / 2;
    } else if (this.mode === 'orbit') this.orbitControls.update();

    const r = this.renderer;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    r.setScissorTest(false);
    r.setViewport(0, 0, w, h);
    r.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);

    if (this.mode === 'walk' && this.minimap !== false) {
      // Sağ altta mini plan.
      const size = Math.round(Math.min(w, h) * 0.32);
      const b = this.model.bounds;
      const half = (Math.max(b.maxX - b.minX, b.maxY - b.minY) / 2) * CM * 1.05;
      const cam = this.miniCam ?? (this.miniCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100));
      Object.assign(cam, { left: -half, right: half, top: half, bottom: -half });
      cam.up.set(0, 0, -1);
      cam.position.set(this.center.x, 30, this.center.z);
      cam.lookAt(this.center);
      cam.layers.enable(1);
      cam.updateProjectionMatrix();
      const ceil = this.house.ceilings.visible;
      this.house.ceilings.visible = false;
      applyCut(this.house, PLAN_CUT);
      r.setScissorTest(true);
      r.setScissor(w - size - 10, 10, size, size);
      r.setViewport(w - size - 10, 10, size, size);
      r.render(this.scene, cam);
      r.setScissorTest(false);
      applyCut(this.house, null);
      this.house.ceilings.visible = ceil;
    }
  }
}
