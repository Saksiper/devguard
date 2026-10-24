// Plan modelinden three.js sahnesi: duvar parçaları, zemin, tavan, kapı kanatları, camlar, sabit engeller.
// Ölçek: 1 three birimi = 1 m. Plan (x, y) cm → three (x/100, z/100 yükseklik, y/100).
//
// Görsel ayrıntılar (süpürgelik, kapı kasası ve kolu, pencere doğraması, dolap kapak bölmeleri) yalnızca
// görünüm içindir: ölçüleri varsayımdır ve hiçbir kontrole girmez.

import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { leafSector } from '../core/plan.js';
import { pointInPolygon } from '../core/geom.js';
import { ceramicTiles, oakPlanks, placed, radiatorFins, woodGrain } from './textures.js';

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

/** Odanın zemin malzemesi: parke (tahta uzun kenar boyunca), seramik (karo ölçüsü floorNote'tan, ör. "60×60"). */
function floorMaterial(r) {
  const note = String(r.floorNote ?? '');
  const m = note.match(/(\d+(?:[.,]\d+)?)\s*[×x]\s*(\d+(?:[.,]\d+)?)/);
  if (r.floor === 'seramik' || r.floor === 'dis') {
    const size = m ? Number(m[1].replace(',', '.')) : r.floor === 'dis' ? 33 : 60;
    const t = r.floor === 'dis' ? ceramicTiles(size, '#c9c2b6', '#a69d90', 9) : ceramicTiles(size);
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
    return std(0xffffff, {
      map: placed(t.map, t.size, !along),
      bumpMap: placed(t.bump, t.size, !along),
      bumpScale: 0.8,
      roughness: 0.5,
    });
  }
  return std(FLOOR_COLORS[r.floor] ?? FLOOR_COLORS.parke);
}

/** Ankastre dolabın ön yüzü: kapak bölmeleri, derzler ve kulplar dokuya çizilir (görsel varsayım). */
function frontTexture(f, material) {
  const px = 3;
  const W = Math.min(1024, Math.round(f.w * px));
  const H = Math.min(1024, Math.round(f.h * px));
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const x = c.getContext('2d');
  const sx = W / f.w;
  const sy = H / f.h;
  if (material === 'cab') {
    const g = woodGrain().image;
    const tw = 70 * sx;
    const th = 140 * sy;
    for (let tx = 0; tx < W; tx += tw) for (let ty = 0; ty < H; ty += th) x.drawImage(g, tx, ty, tw, th);
  } else {
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, W, H);
  }
  const tall = f.h > 150;
  const n = tall && f.w < 75 ? 1 : Math.max(1, Math.round(f.w / 60));
  const dw = f.w / n;
  x.fillStyle = 'rgba(40,30,20,0.55)';
  for (let i = 0; i <= n; i++) x.fillRect(Math.round(i * dw * sx) - 1, 0, 2, H);
  x.fillRect(0, 0, W, 2);
  x.fillRect(0, H - 2, W, 2);
  if (tall && f.h > 190) x.fillRect(0, Math.round(sy * (f.h - 200 + 140)) - 1, W, 2); // üst kapak ayrımı
  // Kulplar: alt dolapta üstte, üst dolapta altta, boy dolapta ~100 cm'de; kapaklar çift çift açılır.
  const hy = f.z >= 120 ? f.h - 10 : tall ? Math.max(8, 100 - f.z) : 8;
  for (let i = 0; i < n; i++) {
    const right = n === 1 ? true : i % 2 === 0;
    const hx = (i + (right ? 1 : 0)) * dw + (right ? -4 : 4);
    const top = (f.h - hy - 7) * sy;
    x.fillStyle = 'rgba(45,45,48,0.95)';
    x.fillRect(hx * sx - 2, top, 4, 14 * sy);
    x.fillStyle = 'rgba(255,255,255,0.35)';
    x.fillRect(hx * sx - 2, top, 1, 14 * sy);
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

  const cuttables = [];
  const edges = []; // planda okunurluk için kenar çizgileri (gerçekçi görünümde gizli)
  const inRoom = (p) => model.rooms.find((r) => pointInPolygon(p, r.poly));

  for (const p of model.pieces) {
    const mat = p.kind === 'parapet' ? MAT.parapet : MAT.wall;
    const mesh = wallBox(p.wall, p.s0, p.s1, p.wall.oMin, p.wall.oMax, p.z0, p.z1, [mat, mat, MAT.wallTop, mat, mat, mat]);
    mesh.userData.piece = p;
    walls.add(mesh);
    cuttables.push(mesh);
    // Süpürgelik: zemine inen parçanın oda tarafındaki yüzlerinde (8 cm × 1,2 cm, varsayım).
    if (p.z0 === 0 && p.kind !== 'parapet') {
      const w = p.wall;
      for (const [face, sg] of [
        [w.oMin, -1],
        [w.oMax, 1],
      ]) {
        const mid = wallPt(w, (p.s0 + p.s1) / 2, face + sg * 6);
        if (!inRoom(mid)) continue;
        const sk = wallBox(w, p.s0, p.s1, face, face + sg * 1.2, 0, 8, MAT.casing);
        sk.receiveShadow = true;
        extras.add(sk);
      }
    }
  }

  const realFloors = [];
  for (const r of model.rooms) {
    const geo = new THREE.ShapeGeometry(shapeFromPoly(r.poly));
    geo.rotateX(-Math.PI / 2);
    const flat = new THREE.MeshLambertMaterial({ color: FLOOR_COLORS[r.floor] ?? FLOOR_COLORS.parke });
    const floor = new THREE.Mesh(geo, flat);
    floor.userData = { room: r, flat, real: floorMaterial(r) };
    floor.position.y = 0.001;
    floors.add(floor);
    realFloors.push(floor);
    if (r.ceiling !== false) {
      const c = new THREE.Mesh(geo, MAT.ceiling);
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
      const glass = wallBox(w, op.s0, op.s1, om - 1, om + 1, op.sill, op.top, op.type === 'door' ? MAT.glassDoor : MAT.glass);
      glass.renderOrder = 2;
      openings.add(glass);
      cuttables.push(glass);
      const line = polyLine([wallPt(w, op.s0, om), wallPt(w, op.s1, om)], 1.3, 0x2563eb, { closed: false });
      aboveMarks.add(line); // yalnızca planda (3D'de doğrama zaten görünür)
      // PVC doğrama: 6 cm kasa, kanatlar arası kayıt (ölçüler varsayım).
      const F = 6;
      const o0 = om - 3.5;
      const o1 = om + 3.5;
      detail(wallBox(w, op.s0, op.s0 + F, o0, o1, op.sill, op.top, MAT.frame), op.sill, op.top);
      detail(wallBox(w, op.s1 - F, op.s1, o0, o1, op.sill, op.top, MAT.frame), op.sill, op.top);
      detail(wallBox(w, op.s0, op.s1, o0, o1, op.top - F, op.top, MAT.frame), op.top - F, op.top);
      detail(wallBox(w, op.s0, op.s1, o0, o1, op.sill, op.sill + (op.type === 'door' ? 4 : F), MAT.frame), op.sill, op.sill + F);
      const panels = Math.max(op.leaves.length, Math.round(op.width / 125), 1);
      for (let k = 1; k < panels; k++) {
        const s = op.s0 + (op.width / panels) * k;
        detail(wallBox(w, s - F / 2 - 1, s + F / 2 + 1, o0, o1, op.sill, op.top, MAT.frame), op.sill, op.top);
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
      detail(wallBox(w, op.s0, op.s0 + K, w.oMin - 1, w.oMax + 1, 0, op.top, MAT.casing), 0, op.top);
      detail(wallBox(w, op.s1 - K, op.s1, w.oMin - 1, w.oMax + 1, 0, op.top, MAT.casing), 0, op.top);
      detail(wallBox(w, op.s0, op.s1, w.oMin - 1, w.oMax + 1, op.top - K, op.top, MAT.casing), op.top - K, op.top);
      for (const [face, sg] of [
        [w.oMin, -1],
        [w.oMax, 1],
      ]) {
        if (!inRoom(wallPt(w, (op.s0 + op.s1) / 2, face + sg * 6))) continue;
        const o1 = face + sg * 1.5;
        detail(wallBox(w, op.s0 - 7, op.s0, face, o1, 0, op.top + 7, MAT.casing), 0, op.top + 7);
        detail(wallBox(w, op.s1, op.s1 + 7, face, o1, 0, op.top + 7, MAT.casing), 0, op.top + 7);
        detail(wallBox(w, op.s0 - 7, op.s1 + 7, face, o1, op.top, op.top + 7, MAT.casing), op.top, op.top + 7);
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
        // Kanat açık (openAngle) konumda çizilir; "closed" kapılar (ör. daire kapısı) kapalı.
        const a = ((leaf.a0 + (op.closed ? 0 : leaf.sign * leaf.openAngle)) * Math.PI) / 180;
        const dir = [Math.cos(a), Math.sin(a)];
        const end = [leaf.hinge[0] + dir[0] * leaf.radius, leaf.hinge[1] + dir[1] * leaf.radius];
        const door = new THREE.Mesh(unitBox, op.glassLeaf ? MAT.frosted : op.leafMaterial === 'steel' ? MAT.steelDoor : MAT.door);
        const mid = [(leaf.hinge[0] + end[0]) / 2, (leaf.hinge[1] + end[1]) / 2];
        door.position.copy(v3(mid[0], mid[1], op.height / 2));
        door.scale.set(leaf.radius * CM, (op.height - 1) * CM, 0.04);
        door.rotation.y = -a;
        door.userData.z = [0, op.height];
        door.castShadow = door.receiveShadow = true;
        openings.add(door);
        planMarks.add(polyLine([leaf.hinge, end], 0.013, 0x374151, { closed: false }));
        // Kapı kolu (iki yüzde, yerden 105 cm).
        const hp = [end[0] - dir[0] * 7, end[1] - dir[1] * 7];
        for (const sg of [-1, 1]) {
          const n = [-dir[1] * sg, dir[0] * sg];
          const lever = new THREE.Mesh(unitBox, MAT.handle);
          const lc = [hp[0] + n[0] * 4 - dir[0] * 5, hp[1] + n[1] * 4 - dir[1] * 5];
          lever.position.copy(v3(lc[0], lc[1], 105));
          lever.scale.set(0.12, 0.018, 0.018);
          lever.rotation.y = -a;
          detail(lever, 0, op.height);
          const rose = new THREE.Mesh(unitBox, MAT.handle);
          rose.position.copy(v3(hp[0] + n[0] * 2.4, hp[1] + n[1] * 2.4, 105));
          rose.scale.set(0.05, 0.05, 0.008);
          rose.rotation.y = -a;
          detail(rose, 0, op.height);
        }
      }
    }
  }

  const cylGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 24);
  const shadeGeo = new THREE.CylinderGeometry(0.3, 0.5, 1, 36, 1, true);
  for (const f of model.fixtures) {
    const key = f.material ?? f.type;
    const color = f.color ? new THREE.Color(f.color) : (MATERIAL_COLORS[f.material] ?? FIXTURE_COLORS[f.type] ?? 0xd1d5db);
    const clear = TRANSPARENT.has(f.type) || TRANSPARENT.has(f.material);
    let mat = std(color, { transparent: clear, opacity: clear ? 0.5 : 1, ...(SURFACE[key] ?? SURFACE[f.type] ?? {}) });
    let geo = f.shape === 'cylinder' ? cylGeo : unitBox;
    if (f.type === 'beam' || f.type === 'column') mat = MAT.wall;
    if (f.type === 'radiator') {
      const fins = placed(radiatorFins(), [2.5, 100]);
      fins.repeat.set(f.w / 2.5, 1);
      mat = std(0xf6f6f4, { map: fins, bumpMap: fins, bumpScale: 2, roughness: 0.4 });
    }
    if (f.type === 'lamp') {
      geo = shadeGeo;
      mat = std(0xf3ead8, { roughness: 0.9, side: THREE.DoubleSide, emissive: 0xfff0d0, emissiveIntensity: 0.12 });
    }
    if ((f.material === 'cab' || f.material === 'white') && f.d >= 20 && f.h >= 30 && !/panel|kaplama/i.test(f.name ?? '')) {
      // Ön yüz: oda tarafına bakan yan (merkezle aynı odada kalan yön).
      const room = inRoom([f.x, f.y]);
      const a = (f.rot * Math.PI) / 180;
      const side = (sg) => {
        const off = f.d / 2 + 25;
        const p = [f.x - Math.sin(a) * off * sg, f.y + Math.cos(a) * off * sg];
        return room && inRoom(p) === room;
      };
      const front = side(1) ? 4 : side(-1) ? 5 : -1;
      if (front >= 0) {
        const body = f.material === 'cab' ? std(color, { map: placed(woodGrain(), [70, 140]), roughness: 0.6 }) : mat;
        const face = std(color, { map: frontTexture(f, f.material), ...SURFACE[f.material] });
        mat = [body, body, body, body, body, body];
        mat[front] = face;
      }
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(v3(f.x, f.y, f.z + f.h / 2));
    mesh.scale.set(f.w * CM, Math.max(f.h, 0.3) * CM, f.d * CM);
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
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 12), MAT.bulb);
      bulb.position.copy(v3(f.x, f.y, f.z + f.h * 0.45));
      bulb.userData.z = [f.z, f.z + f.h];
      extras.add(bulb);
      const cord = new THREE.Mesh(cylGeo, MAT.cord);
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

  return { root, walls, floors, ceilings, openings, fixtures, extras, planMarks, aboveMarks, roomLabels, fixtureLabels, cuttables, edges, realFloors };
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
