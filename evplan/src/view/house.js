// Plan modelinden three.js sahnesi: duvar parçaları, zemin, tavan, kapı kanatları, camlar, sabit engeller.
// Ölçek: 1 three birimi = 1 m. Plan (x, y) cm → three (x/100, z/100 yükseklik, y/100).
//
// Görsel ayrıntılar (süpürgelik, kapı kasası ve kolu, pencere doğraması, dolap kapak bölmeleri) yalnızca
// görünüm içindir: ölçüleri varsayımdır ve hiçbir kontrole girmez.

import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { leafSector } from '../core/plan.js';
import { pointInPolygon } from '../core/geom.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ceramicTiles, oakPlanks, placed, radiatorFins, stripedVeneer, woodGrain } from './textures.js';

export const CM = 0.01;
export const v3 = (x, y, z = 0) => new THREE.Vector3(x * CM, z * CM, y * CM);

const FLOOR_COLORS = { parke: 0xd9c4a0, seramik: 0xe6e4e0, dis: 0xcdc8bf, hali: 0xc9b8a0 };
const FIXTURE_COLORS = {
  radiator: 0xf8fafc,
  column: 0xefede8,
  beam: 0xe9e6e0,
  counter: 0x9aa3ad,
  boiler: 0xf1f5f9,
  shower: 0xbfdbfe,
  wc: 0xffffff,
  sink: 0xf1f5f9,
  lamp: 0xfff4d6,
  post: 0xa1a1aa,
};
// Ankastre malzemeleri (içe aktarılan modeldeki adlar).
const MATERIAL_COLORS = {
  cab: 0xc8a27c,
  white: 0xf5f5f4,
  top: 0x44403c,
  plinth: 0x57534e,
  glassCab: 0xcfe3ee,
  oven: 0x2b2b2d,
  ovenGlass: 0x0e0e10,
  hob: 0x121214,
  steel: 0xc4c8cc,
  cream: 0xece3cc, // krem parlak kapak (antre gardırobu)
  seam: 0x2f2a26, // kapak arası derz
};
// Yüzey özellikleri (pürüzlülük / metal) — renkler yukarıda.
const SURFACE = {
  cab: { roughness: 0.6 },
  white: { roughness: 0.32 },
  top: { roughness: 0.32 },
  plinth: { roughness: 0.6 },
  glassCab: { roughness: 0.1 },
  oven: { roughness: 0.3, metalness: 0.4 },
  ovenGlass: { roughness: 0.05 },
  hob: { roughness: 0.06 },
  steel: { roughness: 0.28, metalness: 0.9 },
  cream: { roughness: 0.18 },
  seam: { roughness: 0.9 },
  radiator: { roughness: 0.4 },
  lamp: { roughness: 0.9 },
};
const TRANSPARENT = new Set(['shower', 'glassCab']);

const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.9, ...o });

export const MAT = {
  wall: std(0xf4f2ee, { roughness: 0.95 }),
  wallTop: std(0x3b4150, { roughness: 1 }), // kesit üstü (planda koyu); ışın izleme yalnızca Standard malzeme bilir
  parapet: std(0xe5e2dc, { roughness: 0.95 }),
  ceiling: std(0xfbfaf8, { roughness: 0.95, side: THREE.DoubleSide }),
  glass: std(0xd6e6ee, { transparent: true, opacity: 0.14, roughness: 0.03, envMapIntensity: 1.4, depthWrite: false }),
  door: std(0xb08a5e, { roughness: 0.55 }),
  frosted: std(0xe8eef2, { transparent: true, opacity: 0.78, roughness: 0.35 }),
  glassDoor: std(0xd6e6ee, { transparent: true, opacity: 0.16, roughness: 0.03, envMapIntensity: 1.4, depthWrite: false }),
  frame: std(0xf7f7f5, { roughness: 0.4 }), // PVC doğrama (varsayım: beyaz)
  casing: std(0xf3f1ec, { roughness: 0.45 }), // kapı pervazı ve süpürgelik (varsayım: beyaz)
  handle: std(0xb9bcc0, { roughness: 0.25, metalness: 0.9 }),
  steelDoor: std(0x5b5752, { roughness: 0.45, metalness: 0.35 }), // çelik daire kapısı (renk varsayım)
  cord: std(0x222222, { roughness: 0.6 }),
  bulb: new THREE.MeshStandardMaterial({ color: 0xfff1d6, emissive: 0xffe2b0, emissiveIntensity: 0.6 }),
};
MAT.door.map = placed(woodGrain(), [70, 140]);

const unitBox = new THREE.BoxGeometry(1, 1, 1);

/** Duvar düzleminde dikdörtgen kutu: s (duvar boyunca), o (kalınlık yönü), z (yükseklik). */
function wallBox(w, s0, s1, o0, o1, z0, z1, material) {
  const mesh = new THREE.Mesh(unitBox, material);
  const sm = (s0 + s1) / 2;
  const om = (o0 + o1) / 2;
  const cx = w.from[0] + w.d[0] * sm + w.n[0] * om;
  const cy = w.from[1] + w.d[1] * sm + w.n[1] * om;
  mesh.position.copy(v3(cx, cy, (z0 + z1) / 2));
  mesh.scale.set(Math.abs(s1 - s0) * CM, (z1 - z0) * CM, Math.abs(o1 - o0) * CM);
  mesh.rotation.y = -Math.atan2(w.d[1], w.d[0]);
  mesh.userData.z = [z0, z1];
  return mesh;
}

const wallPt = (w, s, o) => [w.from[0] + w.d[0] * s + w.n[0] * o, w.from[1] + w.d[1] * s + w.n[1] * o];

function shapeFromPoly(poly) {
  const shape = new THREE.Shape();
  poly.forEach(([x, y], i) => (i ? shape.lineTo(x * CM, -y * CM) : shape.moveTo(x * CM, -y * CM)));
  shape.closePath();
  return shape;
}

export function polyLine(poly, y, color, { closed = true, dashed = false, opacity = 1 } = {}) {
  const pts = poly.map(([x, z]) => new THREE.Vector3(x * CM, y, z * CM));
  if (closed) pts.push(pts[0].clone());
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = dashed
    ? new THREE.LineDashedMaterial({ color, dashSize: 0.06, gapSize: 0.05, transparent: opacity < 1, opacity })
    : new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
  const line = new THREE.Line(geo, mat);
  if (dashed) line.computeLineDistances();
  return line;
}

export function polyFill(poly, y, color, opacity = 0.18) {
  const geo = new THREE.ShapeGeometry(shapeFromPoly(poly));
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide }),
  );
  mesh.position.y = y;
  return mesh;
}

export function label(html, cls, pos) {
  const el = document.createElement('div');
  el.className = `lbl ${cls}`;
  el.innerHTML = html;
  const obj = new CSS2DObject(el);
  obj.position.copy(pos);
  return obj;
}

// ---- Evin gerçek kaplamaları (plan.finishes; data/<set>/finishes.json): renkler evin fotoğraflarından. ----
const finColor = (v) => (v && typeof v === 'object' ? v.color : v) ?? null;
/** Sabit mobilya malzemesinin kaplaması: önce odaya özel (finishes.rooms.<oda>.materials), sonra genel. */
const finishOf = (F, room, key) => F.rooms?.[room?.id]?.materials?.[key] ?? F.materials?.[key] ?? null;
const floorFinish = (F, r) => F.rooms?.[r.id]?.floor ?? F.floors?.[r.floor] ?? null;

/** Yatay lifli kaplama malzemesi; doku gri tonlu, renk ortalaması fin.color olacak şekilde ölçeklenir. */
function veneerMat(fin, wCm, hCm) {
  const t = stripedVeneer(fin.texture).clone();
  const [tw, th] = t.userData.size;
  t.repeat.set(Math.max(1, Math.round(wCm / tw)), hCm / th);
  t.needsUpdate = true;
  return std(new THREE.Color(fin.color).multiplyScalar(1 / t.userData.mean), { map: t, roughness: fin.roughness ?? 0.5 });
}

/**
 * Demir korkuluk (balkon): üstte küpeşte, altında ikinci kayıt, dikey çubuklar, alt kayıt ve dikmeler; tek birleşik
 * geometri. R: { height, ledge (eşik yüksekliği), spacing (çubuk aralığı, cm) }. Ölçüler fotoğraftan tahmini.
 */
function railingMesh(w, s0, s1, R, mat) {
  const om = (w.oMin + w.oMax) / 2;
  const H = R.height;
  const L = R.ledge;
  const parts = [];
  const add = (a, b, half, z0, z1) => {
    const m = wallBox(w, a, b, om - half, om + half, z0, z1, mat);
    m.updateMatrix();
    parts.push(unitBox.clone().applyMatrix4(m.matrix));
  };
  add(s0, s1, 2.6, H - 3.5, H); // küpeşte
  add(s0, s1, 1.4, H - 14, H - 11.5);
  add(s0, s1, 1.4, L + 6, L + 8.5);
  const n = Math.max(1, Math.round((s1 - s0) / (R.spacing ?? 11.6)));
  for (let i = 1; i < n; i++) {
    const c = s0 + ((s1 - s0) * i) / n;
    add(c - 0.7, c + 0.7, 0.7, L + 8.5, H - 14);
  }
  const posts = Math.max(1, Math.round((s1 - s0) / 125));
  for (let i = 0; i <= posts; i++) {
    const c = Math.min(s1 - 2, Math.max(s0 + 2, s0 + ((s1 - s0) * i) / posts));
    add(c - 2, c + 2, 2, L, H - 3.5);
    add(c - 5, c + 5, 4, L, L + 1.2); // taban pulu
  }
  const mesh = new THREE.Mesh(mergeGeometries(parts), mat);
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.userData.z = [L, H];
  return mesh;
}

/**
 * Manzara arka planı (finishes.backdrops): pencereden çekilip düzeltilmiş fotoğraf, çekildiği noktadan (eye)
 * bakınca aynı görünecek şekilde uzağa (distance) dik bir düzleme gerilir. focal = odak / görsel genişliği,
 * center = [ana nokta x, ufuk satırı] (0–1), dir = bakış yönü (plan derecesi; 0 = +x). Kendinden ışıklıdır
 * (sahne ışığından etkilenmez); kenarları saydamlaşır, ardında gök ve dış zemin görünür.
 */
function backdropMesh(b, base) {
  const D = b.distance ?? 6000;
  const aspect = b.aspect ?? 1.5;
  const W = D / b.focal;
  const H = W / aspect;
  const tex = new THREE.TextureLoader().load((base ?? './') + b.image);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const mat = new THREE.MeshStandardMaterial({
    color: 0x000000, map: tex, emissive: 0xffffff, emissiveMap: tex, roughness: 1, envMapIntensity: 0,
    transparent: true, depthWrite: false, fog: false, toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(W * CM, H * CM), mat);
  const a = ((b.dir ?? 0) * Math.PI) / 180;
  const [ex, ey, ez] = b.eye;
  const [cu, cv] = b.center ?? [0.5, 0.5];
  // Düzlemin merkezi: bakış ekseninden (0,5 − cu)·W sağa, (cv − 0,5)·H yukarı kaymış.
  const right = [-Math.sin(a), Math.cos(a)];
  const px = ex + Math.cos(a) * D + right[0] * (0.5 - cu) * W;
  const py = ey + Math.sin(a) * D + right[1] * (0.5 - cu) * W;
  const top = ez + cv * H;
  mesh.position.copy(v3(px, py, top - H / 2));
  mesh.rotation.y = -Math.PI / 2 - a;
  mesh.userData.backdrop = { bottom: top - H };
  mesh.visible = false; // yalnız yürürken (viewer açar)
  mesh.renderOrder = -1;
  return mesh;
}

/** Plan görünümündeki düz zemin rengi: kaplama rengi varsa onun açılmışı (okunurluk için). */
function flatFloorColor(F, r) {
  const c = finColor(floorFinish(F, r));
  return c ? new THREE.Color(c).lerp(new THREE.Color(0xffffff), 0.35) : new THREE.Color(FLOOR_COLORS[r.floor] ?? FLOOR_COLORS.parke);
}

/** Odanın zemin malzemesi: parke (tahta uzun kenar boyunca), seramik (karo ölçüsü floorNote'tan, ör. "60×60"). */
function floorMaterial(r, F = {}) {
  const note = String(r.floorNote ?? '');
  const m = note.match(/(\d+(?:[.,]\d+)?)\s*[×x]\s*(\d+(?:[.,]\d+)?)/);
  const fin = floorFinish(F, r);
  if (r.floor === 'seramik' || r.floor === 'dis') {
    const size = m ? Number(m[1].replace(',', '.')) : r.floor === 'dis' ? 33 : 60;
    const t = r.floor === 'dis' ? ceramicTiles(size, fin?.color ?? '#c9c2b6', fin?.grout ?? '#a69d90', 9) : ceramicTiles(size, fin?.color ?? '#ebe9e4', fin?.grout ?? '#c9c4bb');
    return std(0xffffff, {
      map: placed(t.map, t.size),
      bumpMap: placed(t.bump, t.size),
      bumpScale: 0.6,
      roughness: r.floor === 'dis' ? 0.75 : 0.22,
    });
  }
  if (r.floor === 'parke' || !r.floor) {
    const t = oakPlanks();
    const along = r.size[0] >= r.size[1]; // tahtalar odanın uzun kenarı boyunca (varsayım)
    // Parke tonu: doku meşe (#bc9a74 tabanlı); kaplama rengi verilmişse ona oranlanır.
    const tint = fin?.color ? new THREE.Color(fin.color).multiply(new THREE.Color(1 / 0.503, 1 / 0.323, 1 / 0.174)) : 0xffffff;
    return std(tint, {
      map: placed(t.map, t.size, !along),
      bumpMap: placed(t.bump, t.size, !along),
      bumpScale: 0.8,
      roughness: fin?.roughness ?? 0.5,
    });
  }
  return std(FLOOR_COLORS[r.floor] ?? FLOOR_COLORS.parke);
}

/**
 * Ankastre dolabın ön yüzü: kapak bölmeleri, derzler ve kulplar dokuya çizilir (görsel varsayım).
 * fin (kaplama) verilirse renk dokuya işlenir (malzeme rengi beyaz kalır): fin.texture yatay lifli kaplama,
 * fin.handle 'inset' (gömme yatay çelik kulp) | 'none'; 'glassCab' → alüminyum çerçeveli buzlu cam kapaklar.
 */
function frontTexture(f, material, fin = null) {
  const px = 3;
  const W = Math.min(1024, Math.round(f.w * px));
  const H = Math.min(1024, Math.round(f.h * px));
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const x = c.getContext('2d');
  const sx = W / f.w;
  const sy = H / f.h;
  const tall = f.h > 150;
  const n = tall && f.w < 75 ? 1 : Math.max(1, Math.round(f.w / (fin?.doorWidth ?? 60)));
  const dw = f.w / n;
  if (material === 'glassCab') {
    x.fillStyle = fin?.frame ?? '#b9bcbf';
    x.fillRect(0, 0, W, H);
    const fw = 4.5;
    for (let i = 0; i < n; i++) {
      const g = x.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, fin?.color ?? '#d5d8cc');
      g.addColorStop(1, '#c4c8bd');
      x.fillStyle = g;
      x.fillRect((i * dw + fw) * sx, fw * sy, (dw - 2 * fw) * sx, (f.h - 2 * fw) * sy);
      x.fillStyle = 'rgba(60,62,66,0.55)';
      x.fillRect(Math.round(i * dw * sx) - 1, 0, 2, H);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }
  if (fin?.texture) {
    const v = stripedVeneer(fin.texture);
    const k = 1 / v.userData.meanSrgb;
    const rgb = [1, 3, 5].map((i) => Math.min(255, Math.round(parseInt(fin.color.slice(i, i + 2), 16) * k)));
    x.fillStyle = `rgb(${rgb})`;
    x.fillRect(0, 0, W, H);
    x.globalCompositeOperation = 'multiply';
    const tw = v.userData.size[0] * sx;
    const th = v.userData.size[1] * sy;
    for (let tx = 0; tx < W; tx += tw) for (let ty = 0; ty < H; ty += th) x.drawImage(v.image, tx, ty, tw, th);
    x.globalCompositeOperation = 'source-over';
  } else if (material === 'cab') {
    const g = woodGrain().image;
    const tw = 70 * sx;
    const th = 140 * sy;
    for (let tx = 0; tx < W; tx += tw) for (let ty = 0; ty < H; ty += th) x.drawImage(g, tx, ty, tw, th);
  } else {
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, W, H);
  }
  x.fillStyle = fin?.texture ? 'rgba(30,18,10,0.6)' : 'rgba(40,30,20,0.55)';
  for (let i = 0; i <= n; i++) x.fillRect(Math.round(i * dw * sx) - 1, 0, 2, H);
  x.fillRect(0, 0, W, 2);
  x.fillRect(0, H - 2, W, 2);
  // Tuvalin üst satırı dolabın üstüdür: yerden yükseklik hb → tuval y = (f.h − (hb − f.z)) · sy.
  if (tall && f.h > 190) x.fillRect(0, Math.round(sy * (f.h - (140 - f.z))) - 1, W, 2); // üst kapak ayrımı (yerden 140 cm)
  // Kulplar: alt dolapta üstte, üst dolapta altta, boy dolapta ~100 cm'de; kapaklar çift çift açılır.
  // hy = kulp merkezinin dolabın üstünden uzaklığı.
  const hy = f.z >= 120 ? f.h - 8 : tall ? f.h - Math.max(8, 100 - f.z) : 8;
  if (fin?.handle === 'none') {
    // kulpsuz (bas-aç) kapak
  } else if (fin?.handle === 'inset') {
    // Gömme yatay çelik kulp (≈16 × 4,5 cm), kapağın ortasında.
    for (let i = 0; i < n; i++) {
      const hw = Math.min(16, dw * 0.5);
      const hx = ((i + 0.5) * dw - hw / 2) * sx;
      const top = (hy - 2.25) * sy;
      x.fillStyle = '#d3d6da';
      x.fillRect(hx, top, hw * sx, 4.5 * sy);
      x.fillStyle = '#6f757c';
      x.fillRect(hx + 0.6 * sx, top + 0.6 * sy, (hw - 1.2) * sx, 2.4 * sy);
      x.fillStyle = '#a9aeb4';
      x.fillRect(hx + 0.6 * sx, top + 3 * sy, (hw - 1.2) * sx, 0.9 * sy);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const right = n === 1 ? true : i % 2 === 0;
      const hx = (i + (right ? 1 : 0)) * dw + (right ? -4 : 4);
      const top = (hy - 7) * sy;
      x.fillStyle = 'rgba(45,45,48,0.95)';
      x.fillRect(hx * sx - 2, top, 4, 14 * sy);
      x.fillStyle = 'rgba(255,255,255,0.35)';
      x.fillRect(hx * sx - 2, top, 1, 14 * sy);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function buildHouse(model) {
  const root = new THREE.Group();
  root.name = 'house';
  const walls = new THREE.Group();
  const floors = new THREE.Group();
  const ceilings = new THREE.Group();
  const openings = new THREE.Group();
  const fixtures = new THREE.Group();
  const extras = new THREE.Group(); // süpürgelik, lamba kablosu (planda gizli)
  const planMarks = new THREE.Group(); // plan ve 3D'de (kapı yayları vb.)
  const aboveMarks = new THREE.Group(); // yalnızca planda: kesit üstündeki kiriş/dolap/lamba izleri
  const roomLabels = new THREE.Group();
  const fixtureLabels = new THREE.Group();
  root.add(walls, floors, ceilings, openings, fixtures, extras, planMarks, aboveMarks, roomLabels, fixtureLabels);

  // Bu evin malzemeleri: varsayılanlar (MAT) + plan.finishes'taki gerçek kaplamalar.
  const F = model.plan?.finishes ?? {};
  const M = { ...MAT };
  if (F.wall) M.wall = std(finColor(F.wall), { roughness: F.wall.roughness ?? 0.95 });
  if (F.ceiling) M.ceiling = std(finColor(F.ceiling), { roughness: 0.95, side: THREE.DoubleSide });
  M.beam = F.beam ? std(finColor(F.beam), { roughness: 0.95 }) : M.wall; // cam üstü kiriş duvar renginde (salon fotoğrafı)
  M.cornice = std(finColor(F.cornice) ?? 0xf6f4f0, { roughness: 0.9 });
  const RAIL = F.railing ? { height: 105, ledge: F.railing.ledgeHeight ?? 12, spacing: F.railing.spacing } : null;
  M.rail = std(finColor(F.railing) ?? 0x8e9193, { roughness: 0.45, metalness: 0.6 });
  M.ledge = std(F.railing?.ledge ?? 0xcfcdc8, { roughness: 0.4 });
  if (F.doorFrame) M.casing = std(finColor(F.doorFrame), { roughness: 0.5 });
  M.skirting = F.skirting ? std(finColor(F.skirting), { roughness: 0.45 }) : M.casing;
  if (F.door?.texture) M.door = veneerMat(F.door, 90, 205);
  else if (F.door) M.door = std(finColor(F.door), { roughness: 0.5 });
  if (F.entranceDoor?.texture) M.steelDoor = veneerMat(F.entranceDoor, 95, 205);
  else if (F.entranceDoor) M.steelDoor = std(finColor(F.entranceDoor), { roughness: 0.5 });
  if (F.windowFrame) M.frame = std(finColor(F.windowFrame), { roughness: 0.4 });

  const cuttables = [];
  const doorLeaves = []; // menteşeli kapı kanatları (dönen gruplar)
  const edges = []; // planda okunurluk için kenar çizgileri (gerçekçi görünümde gizli)
  const inRoom = (p) => model.rooms.find((r) => pointInPolygon(p, r.poly));

  for (const p of model.pieces) {
    const railed = p.kind === 'parapet' && RAIL; // demir korkuluk: duvar yerine alçak eşik + çubuklar
    const mat = railed ? M.ledge : p.kind === 'parapet' ? M.parapet : M.wall;
    const mesh = wallBox(p.wall, p.s0, p.s1, p.wall.oMin, p.wall.oMax, p.z0, railed ? RAIL.ledge : p.z1, [mat, mat, railed ? mat : M.wallTop, mat, mat, mat]);
    mesh.userData.piece = p;
    walls.add(mesh);
    cuttables.push(mesh);
    if (railed) extras.add(railingMesh(p.wall, p.s0, p.s1, { ...RAIL, height: p.z1 }, M.rail));
    // Kartonpiyer: tavana ulaşan duvar parçalarının oda yüzünde iki kademeli beyaz kuşak.
    if (F.cornice && p.kind !== 'parapet') {
      const w = p.wall;
      const size = F.cornice.size ?? 10;
      for (const [face, sg] of [
        [w.oMin, -1],
        [w.oMax, 1],
      ]) {
        const room = inRoom(wallPt(w, (p.s0 + p.s1) / 2, face + sg * 6));
        if (!room || room.ceiling === false || p.z1 < room.ceilingHeight - 2) continue;
        const c = room.ceilingHeight;
        extras.add(wallBox(w, p.s0, p.s1, face, face + sg * size, c - size * 0.45, c, M.cornice));
        extras.add(wallBox(w, p.s0, p.s1, face, face + sg * size * 0.45, c - size, c - size * 0.45, M.cornice));
      }
    }
    // Süpürgelik: zemine inen parçanın oda tarafındaki yüzlerinde (8 cm × 1,2 cm, varsayım).
    if (p.z0 === 0 && p.kind !== 'parapet') {
      const w = p.wall;
      for (const [face, sg] of [
        [w.oMin, -1],
        [w.oMax, 1],
      ]) {
        const mid = wallPt(w, (p.s0 + p.s1) / 2, face + sg * 6);
        if (!inRoom(mid)) continue;
        const sk = wallBox(w, p.s0, p.s1, face, face + sg * 1.2, 0, 8, M.skirting);
        sk.receiveShadow = true;
        extras.add(sk);
      }
    }
  }

  const realFloors = [];
  for (const r of model.rooms) {
    const geo = new THREE.ShapeGeometry(shapeFromPoly(r.poly));
    geo.rotateX(-Math.PI / 2);
    const flat = new THREE.MeshLambertMaterial({ color: flatFloorColor(F, r) });
    const floor = new THREE.Mesh(geo, flat);
    floor.userData = { room: r, flat, real: floorMaterial(r, F) };
    floor.position.y = 0.001;
    floors.add(floor);
    realFloors.push(floor);
    if (r.ceiling !== false) {
      const c = new THREE.Mesh(geo, M.ceiling);
      c.position.y = r.ceilingHeight * CM;
      ceilings.add(c);
    }
    const dims = r.isRect ? `${Math.round(r.size[0])} × ${Math.round(r.size[1])} cm` : '';
    const rl = label(`${r.name}<small>${r.area.toFixed(1)} m²${dims ? ` · ${dims}` : ''}</small>`, 'room', v3(r.center[0], r.center[1], 5));
    rl.userData.room = r;
    roomLabels.add(rl);
  }

  const detail = (mesh, z0, z1) => {
    mesh.userData.z = [z0, z1];
    mesh.castShadow = mesh.receiveShadow = true;
    openings.add(mesh);
    return mesh;
  };

  for (const op of model.openings) {
    const w = op.wallRef;
    const om = (w.oMin + w.oMax) / 2;
    if (op.type === 'window' || op.glazed) {
      const glass = wallBox(w, op.s0, op.s1, om - 1, om + 1, op.sill, op.top, op.type === 'door' ? M.glassDoor : M.glass);
      glass.renderOrder = 2;
      openings.add(glass);
      cuttables.push(glass);
      const line = polyLine([wallPt(w, op.s0, om), wallPt(w, op.s1, om)], 1.3, 0x2563eb, { closed: false });
      aboveMarks.add(line); // yalnızca planda (3D'de doğrama zaten görünür)
      // Doğrama: kasa (varsayılan 6 cm), kanatlar arası kayıt; finishes.window.sash > 0 ise açılan kanatlara
      // ayrı kanat çerçevesi (camı daraltır; salon fotoğrafındaki kalın koyu doğrama).
      const F = model.plan?.finishes?.window?.frame ?? 6;
      const SASH = model.plan?.finishes?.window?.sash ?? 0;
      const o0 = om - 3.5;
      const o1 = om + 3.5;
      detail(wallBox(w, op.s0, op.s0 + F, o0, o1, op.sill, op.top, M.frame), op.sill, op.top);
      detail(wallBox(w, op.s1 - F, op.s1, o0, o1, op.sill, op.top, M.frame), op.sill, op.top);
      detail(wallBox(w, op.s0, op.s1, o0, o1, op.top - F, op.top, M.frame), op.top - F, op.top);
      detail(wallBox(w, op.s0, op.s1, o0, o1, op.sill, op.sill + (op.type === 'door' ? 4 : F), M.frame), op.sill, op.sill + F);
      const panels = Math.max(op.leaves.length, Math.round(op.width / 125), 1);
      for (let k = 1; k < panels; k++) {
        const s = op.s0 + (op.width / panels) * k;
        detail(wallBox(w, s - F / 2 - 1, s + F / 2 + 1, o0, o1, op.sill, op.top, M.frame), op.sill, op.top);
      }
      if (SASH && op.type === 'door') {
        const pw = op.width / panels;
        const zb = op.sill + 4;
        const zt = op.top - F;
        for (let k = 0; k < panels; k++) {
          const a = op.s0 + pw * k + (k === 0 ? F : F / 2 + 1);
          const b = op.s0 + pw * (k + 1) - (k === panels - 1 ? F : F / 2 + 1);
          const q0 = o0 - 0.8;
          const q1 = o1 + 0.8;
          detail(wallBox(w, a, a + SASH, q0, q1, zb, zt, M.frame), zb, zt);
          detail(wallBox(w, b - SASH, b, q0, q1, zb, zt, M.frame), zb, zt);
          detail(wallBox(w, a, b, q0, q1, zt - SASH, zt, M.frame), zt - SASH, zt);
          detail(wallBox(w, a, b, q0, q1, zb, zb + SASH, M.frame), zb, zb + SASH);
        }
      }
      if (op.sill > 20) {
        // İç denizlik (mermer, varsayım).
        const face = Math.abs(w.oMin) < Math.abs(w.oMax) ? w.oMin : w.oMax;
        const sg = face === w.oMin ? -1 : 1;
        detail(wallBox(w, op.s0 - 3, op.s1 + 3, om, face + sg * 4, op.sill - 3, op.sill, std(0xe9e6df, { roughness: 0.25 })), op.sill - 3, op.sill);
      }
    } else if (op.type === 'door') {
      // Kapı kasası (açıklığın içi) ve iki yüzde pervaz (7 cm; varsayım).
      const K = 2;
      detail(wallBox(w, op.s0, op.s0 + K, w.oMin - 1, w.oMax + 1, 0, op.top, M.casing), 0, op.top);
      detail(wallBox(w, op.s1 - K, op.s1, w.oMin - 1, w.oMax + 1, 0, op.top, M.casing), 0, op.top);
      detail(wallBox(w, op.s0, op.s1, w.oMin - 1, w.oMax + 1, op.top - K, op.top, M.casing), op.top - K, op.top);
      for (const [face, sg] of [
        [w.oMin, -1],
        [w.oMax, 1],
      ]) {
        if (!inRoom(wallPt(w, (op.s0 + op.s1) / 2, face + sg * 6))) continue;
        const o1 = face + sg * 1.5;
        detail(wallBox(w, op.s0 - 7, op.s0, face, o1, 0, op.top + 7, M.casing), 0, op.top + 7);
        detail(wallBox(w, op.s1, op.s1 + 7, face, o1, 0, op.top + 7, M.casing), 0, op.top + 7);
        detail(wallBox(w, op.s0 - 7, op.s1 + 7, face, o1, op.top, op.top + 7, M.casing), op.top, op.top + 7);
      }
    }
    for (const leaf of op.leaves) {
      const sector = leafSector(leaf, 16);
      const arc = sector.slice(1);
      const y = (op.type === 'door' ? 0.5 : op.sill) * CM + 0.003;
      planMarks.add(polyLine(arc, op.type === 'door' ? 0.012 : y, op.type === 'door' ? 0x6b7280 : 0x60a5fa, { closed: false, dashed: true }));
      if (op.type === 'door' && op.glazed && op.leaves.length) {
        // Camlı kapı/balkon kapısı: kapalı cam olarak çizilir (planda açılma yayı yine görünür).
      } else if (op.type === 'door') {
        // Kanat açık (openAngle) konumda çizilir; "closed" kapılar (ör. daire kapısı) kapalı. Kanat ve kolları
        // menteşede dönen bir grupta: yürürken kapıya dokununca açılıp kapanır (userData.door).
        const closedA = (leaf.a0 * Math.PI) / 180;
        const openA = ((leaf.a0 + leaf.sign * leaf.openAngle) * Math.PI) / 180;
        const a = op.closed ? closedA : openA;
        const dir = [Math.cos(a), Math.sin(a)];
        const end = [leaf.hinge[0] + dir[0] * leaf.radius, leaf.hinge[1] + dir[1] * leaf.radius];
        const pivot = new THREE.Group();
        pivot.position.copy(v3(leaf.hinge[0], leaf.hinge[1], 0));
        pivot.rotation.y = -a;
        pivot.userData.z = [0, op.height];
        pivot.userData.door = { id: op.id, hinge: leaf.hinge, radius: leaf.radius, closed: -closedA, open: -openA, isOpen: !op.closed, target: -a };
        const door = new THREE.Mesh(unitBox, op.glassLeaf ? M.frosted : op.leafMaterial === 'steel' ? M.steelDoor : M.door);
        // Kanat yerel +x boyunca (menteşeden uca); yerel z kanadın iki yüzü.
        door.position.set((leaf.radius / 2) * CM, (op.height / 2) * CM, 0);
        door.scale.set(leaf.radius * CM, (op.height - 1) * CM, 0.04);
        door.castShadow = door.receiveShadow = true;
        door.userData.doorPivot = pivot;
        pivot.add(door);
        planMarks.add(polyLine([leaf.hinge, end], 0.013, 0x374151, { closed: false }));
        // Kapı kolu (iki yüzde, yerden 105 cm).
        for (const sg of [-1, 1]) {
          const lever = new THREE.Mesh(unitBox, M.handle);
          lever.position.set((leaf.radius - 12) * CM, 105 * CM, 4 * sg * CM);
          lever.scale.set(0.12, 0.018, 0.018);
          const rose = new THREE.Mesh(unitBox, M.handle);
          rose.position.set((leaf.radius - 7) * CM, 105 * CM, 2.4 * sg * CM);
          rose.scale.set(0.05, 0.05, 0.008);
          for (const m of [lever, rose]) {
            m.castShadow = m.receiveShadow = true;
            pivot.add(m);
          }
        }
        openings.add(pivot);
        doorLeaves.push(pivot);
      }
    }
  }

  const cylGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 24);
  const shadeGeo = new THREE.CylinderGeometry(0.3, 0.5, 1, 36, 1, true);
  for (const f of model.fixtures) {
    const key = f.material ?? f.type;
    const froom = inRoom([f.x, f.y]);
    const fin = f.material ? finishOf(F, froom, f.material) : null; // evin gerçek kaplaması (varsa)
    const color = f.color ? new THREE.Color(f.color) : fin?.color ? new THREE.Color(fin.color) : (MATERIAL_COLORS[f.material] ?? FIXTURE_COLORS[f.type] ?? 0xd1d5db);
    const clear = (TRANSPARENT.has(f.type) || TRANSPARENT.has(f.material)) && !(fin && fin.opacity === 1);
    const surf = { ...(SURFACE[key] ?? SURFACE[f.type] ?? {}) };
    if (fin?.roughness !== undefined) surf.roughness = fin.roughness;
    if (fin?.metalness !== undefined) surf.metalness = fin.metalness;
    let mat = fin?.texture && !f.color ? veneerMat(fin, Math.max(f.w, f.d), f.h) : std(color, { transparent: clear, opacity: clear ? 0.5 : 1, ...surf });
    let geo = f.shape === 'cylinder' ? cylGeo : unitBox;
    if (f.type === 'beam') mat = M.beam;
    if (f.type === 'column') mat = M.wall;
    if (f.type === 'radiator') {
      const tube = F.radiatorTube ?? 2.5; // dikey dilim aralığı (cm)
      const fins = placed(radiatorFins(), [tube, 100]);
      fins.repeat.set(f.w / tube, 1);
      mat = std(0xf6f6f4, { map: fins, bumpMap: fins, bumpScale: 2, roughness: 0.4 });
    }
    const bareBulb = f.type === 'lamp' && F.lamp === 'bulb'; // abajursuz: siyah duy + ampul (evdeki gibi)
    if (f.type === 'lamp') {
      geo = bareBulb ? cylGeo : shadeGeo;
      mat = bareBulb ? M.cord : std(0xf3ead8, { roughness: 0.9, side: THREE.DoubleSide, emissive: 0xfff0d0, emissiveIntensity: 0.12 });
    }
    if ((f.material === 'cab' || f.material === 'white' || (f.material === 'glassCab' && fin)) && f.d >= 20 && f.h >= 30 && !/panel|kaplama/i.test(f.name ?? '')) {
      // Ön yüz: oda tarafına bakan yan (merkezle aynı odada kalan yön).
      const room = froom;
      const a = (f.rot * Math.PI) / 180;
      const side = (sg) => {
        const off = f.d / 2 + 25;
        const p = [f.x - Math.sin(a) * off * sg, f.y + Math.cos(a) * off * sg];
        return room && inRoom(p) === room;
      };
      // Duvar boyunca uzanan dar-derin dolap (ör. antre gardırobu: w 60, d 202): ön yüz yerel ±x.
      const sideX = (sg) => {
        const off = f.w / 2 + 25;
        const p = [f.x + Math.cos(a) * off * sg, f.y + Math.sin(a) * off * sg];
        return room && inRoom(p) === room;
      };
      const deep = f.d > f.w * 1.5;
      const front = deep ? (sideX(1) ? 0 : sideX(-1) ? 1 : -1) : side(1) ? 4 : side(-1) ? 5 : -1;
      if (front >= 0) {
        const baked = !!fin?.texture || f.material === 'glassCab'; // renk dokuya işlendi
        const body = fin?.texture || f.material !== 'cab' ? mat : std(color, { map: placed(woodGrain(), [70, 140]), roughness: 0.6 });
        const face = std(baked ? 0xffffff : color, { map: frontTexture(deep ? { ...f, w: f.d } : f, f.material, fin), ...surf });
        mat = [body, body, body, body, body, body];
        mat[front] = face;
      }
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(v3(f.x, f.y, f.z + f.h / 2));
    mesh.scale.set(f.w * CM, Math.max(f.h, 0.3) * CM, f.d * CM);
    if (bareBulb) {
      mesh.scale.set(0.045, 0.07, 0.045); // duy
      mesh.position.copy(v3(f.x, f.y, f.z + f.h - 3.5));
    }
    mesh.rotation.y = (-f.rot * Math.PI) / 180;
    mesh.userData.fixture = f;
    mesh.userData.z = [f.z, f.z + f.h];
    fixtures.add(mesh);
    if (f.shape !== 'cylinder' && f.collides && Math.min(f.w, f.d) > 3) {
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(unitBox), new THREE.LineBasicMaterial({ color: 0x9ca3af }));
      mesh.add(e);
      edges.push(e);
    }
    if (f.type === 'lamp') {
      // Ampul ve tavana kablo.
      const room = inRoom([f.x, f.y]);
      const ceil = room?.ceilingHeight ?? model.settings.ceilingHeight;
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(bareBulb ? 0.045 : 0.035, 16, 12), M.bulb);
      bulb.position.copy(v3(f.x, f.y, bareBulb ? f.z + f.h - 11 : f.z + f.h * 0.45));
      bulb.userData.z = [f.z, f.z + f.h];
      extras.add(bulb);
      const cord = new THREE.Mesh(cylGeo, M.cord);
      cord.position.copy(v3(f.x, f.y, (f.z + f.h + ceil) / 2));
      cord.scale.set(0.008, Math.max(1, ceil - f.z - f.h) * CM, 0.008);
      cord.userData.z = [f.z + f.h, ceil];
      extras.add(cord);
    }
    if (f.type === 'radiator' || f.type === 'boiler') {
      fixtureLabels.add(label(f.type === 'boiler' ? 'kombi' : 'petek', 'item', v3(f.x, f.y, f.z + f.h + 2)));
    }
    cuttables.push(mesh);
    // Kesit yüksekliğinin üstündekiler (kiriş, üst dolap, kombi) planda kesik çizgiyle gösterilir.
    if (f.z >= 120) aboveMarks.add(polyLine(f.poly, 1.25, 0x6b7280, { dashed: true }));
  }

  // Manzara arka planları (yalnız yürürken görünür; viewer yönetir).
  const backdrops = (F.backdrops ?? []).map((b) => backdropMesh(b, F._base));
  for (const b of backdrops) root.add(b);

  return { root, walls, floors, ceilings, openings, fixtures, extras, planMarks, aboveMarks, roomLabels, fixtureLabels, cuttables, edges, realFloors, doorLeaves, backdrops };
}

/** Gerçekçi görünüm (3D / yürü): dokulu zemin, kenar çizgisi yok. Plan: düz renk + kenar çizgileri. */
export function setRealistic(house, on) {
  for (const f of house.realFloors) f.material = on ? f.userData.real : f.userData.flat;
  for (const e of house.edges) e.visible = !on;
  house.extras.visible = on;
}

/** Duvarları belirli yükseklikte "keser" (plan görünümü ve 3D kesit). cut = null → tam yükseklik. */
export function applyCut(house, cut) {
  for (const m of house.cuttables) {
    const [z0, z1] = m.userData.z;
    if (cut !== null && z0 >= cut) {
      m.visible = false;
      continue;
    }
    m.visible = true;
    const top = cut === null ? z1 : Math.min(z1, cut);
    m.scale.y = (top - z0) * CM;
    m.position.y = ((z0 + top) / 2) * CM;
  }
  for (const d of house.openings.children) {
    if (!d.userData.z || house.cuttables.includes(d)) continue;
    d.visible = cut === null || cut > 150;
  }
  for (const d of house.extras.children) d.visible = cut === null || d.userData.z?.[1] <= cut || !d.userData.z;
}
