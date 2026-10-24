// Plan modelinden three.js sahnesi: duvar parçaları, zemin, tavan, kapı kanatları, camlar, sabit engeller.
// Ölçek: 1 three birimi = 1 m. Plan (x, y) cm → three (x/100, z/100 yükseklik, y/100).

import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { leafSector } from '../core/plan.js';

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
  oven: 0x1f2937,
  ovenGlass: 0x0f172a,
  hob: 0x111827,
  steel: 0xa1a1aa,
};
const TRANSPARENT = new Set(['shower', 'glassCab']);

export const MAT = {
  wall: new THREE.MeshLambertMaterial({ color: 0xf4f2ee }),
  wallTop: new THREE.MeshLambertMaterial({ color: 0x3b4150 }),
  parapet: new THREE.MeshLambertMaterial({ color: 0xe5e2dc }),
  ceiling: new THREE.MeshLambertMaterial({ color: 0xfbfaf8, side: THREE.DoubleSide }),
  glass: new THREE.MeshLambertMaterial({ color: 0x9ec9f0, transparent: true, opacity: 0.35, depthWrite: false }),
  door: new THREE.MeshLambertMaterial({ color: 0xb08a5e }),
  frosted: new THREE.MeshLambertMaterial({ color: 0xe8eef2, transparent: true, opacity: 0.75 }),
  glassDoor: new THREE.MeshLambertMaterial({ color: 0x7fb3d9, transparent: true, opacity: 0.4, depthWrite: false }),
  frame: new THREE.MeshLambertMaterial({ color: 0xffffff }),
};

const unitBox = new THREE.BoxGeometry(1, 1, 1);

/** Duvar düzleminde dikdörtgen kutu: s (duvar boyunca), o (kalınlık yönü), z (yükseklik). */
function wallBox(w, s0, s1, o0, o1, z0, z1, material) {
  const mesh = new THREE.Mesh(unitBox, material);
  const sm = (s0 + s1) / 2;
  const om = (o0 + o1) / 2;
  const cx = w.from[0] + w.d[0] * sm + w.n[0] * om;
  const cy = w.from[1] + w.d[1] * sm + w.n[1] * om;
  mesh.position.copy(v3(cx, cy, (z0 + z1) / 2));
  mesh.scale.set((s1 - s0) * CM, (z1 - z0) * CM, (o1 - o0) * CM);
  mesh.rotation.y = -Math.atan2(w.d[1], w.d[0]);
  mesh.userData.z = [z0, z1];
  return mesh;
}

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

export function buildHouse(model) {
  const root = new THREE.Group();
  root.name = 'house';
  const walls = new THREE.Group();
  const floors = new THREE.Group();
  const ceilings = new THREE.Group();
  const openings = new THREE.Group();
  const fixtures = new THREE.Group();
  const planMarks = new THREE.Group(); // plan ve 3D'de (kapı yayları vb.)
  const aboveMarks = new THREE.Group(); // yalnızca planda: kesit üstündeki kiriş/dolap/lamba izleri
  const roomLabels = new THREE.Group();
  const fixtureLabels = new THREE.Group();
  root.add(walls, floors, ceilings, openings, fixtures, planMarks, aboveMarks, roomLabels, fixtureLabels);

  const cuttables = [];

  for (const p of model.pieces) {
    const mat = p.kind === 'parapet' ? MAT.parapet : MAT.wall;
    const mesh = wallBox(p.wall, p.s0, p.s1, p.wall.oMin, p.wall.oMax, p.z0, p.z1, [mat, mat, MAT.wallTop, mat, mat, mat]);
    mesh.userData.piece = p;
    walls.add(mesh);
    cuttables.push(mesh);
  }

  for (const r of model.rooms) {
    const geo = new THREE.ShapeGeometry(shapeFromPoly(r.poly));
    geo.rotateX(-Math.PI / 2);
    const floor = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: FLOOR_COLORS[r.floor] ?? FLOOR_COLORS.parke }));
    floor.position.y = 0.001;
    floor.userData.room = r;
    floors.add(floor);
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

  for (const op of model.openings) {
    const w = op.wallRef;
    if (op.type === 'window' || op.glazed) {
      const om = (w.oMin + w.oMax) / 2;
      const glass = wallBox(w, op.s0, op.s1, om - 1, om + 1, op.sill, op.top, op.type === 'door' ? MAT.glassDoor : MAT.glass);
      glass.renderOrder = 2;
      openings.add(glass);
      cuttables.push(glass);
      const line = polyLine(
        [
          [w.from[0] + w.d[0] * op.s0 + w.n[0] * om, w.from[1] + w.d[1] * op.s0 + w.n[1] * om],
          [w.from[0] + w.d[0] * op.s1 + w.n[0] * om, w.from[1] + w.d[1] * op.s1 + w.n[1] * om],
        ],
        1.3,
        0x2563eb,
        { closed: false },
      );
      planMarks.add(line);
    }
    for (const leaf of op.leaves) {
      const sector = leafSector(leaf, 16);
      const arc = sector.slice(1);
      const y = (op.type === 'door' ? 0.5 : op.sill) * CM + 0.003;
      planMarks.add(polyLine(arc, op.type === 'door' ? 0.012 : y, op.type === 'door' ? 0x6b7280 : 0x60a5fa, { closed: false, dashed: true }));
      if (op.type === 'door' && op.glazed && op.leaves.length) {
        // Camlı kapı/balkon kapısı: kapalı cam olarak çizilir (planda açılma yayı yine görünür).
      } else if (op.type === 'door') {
        // Kanat açık (openAngle) konumda çizilir.
        const a = ((leaf.a0 + leaf.sign * leaf.openAngle) * Math.PI) / 180;
        const end = [leaf.hinge[0] + Math.cos(a) * leaf.radius, leaf.hinge[1] + Math.sin(a) * leaf.radius];
        const door = new THREE.Mesh(unitBox, op.glassLeaf ? MAT.frosted : MAT.door);
        const mid = [(leaf.hinge[0] + end[0]) / 2, (leaf.hinge[1] + end[1]) / 2];
        door.position.copy(v3(mid[0], mid[1], op.height / 2));
        door.scale.set(leaf.radius * CM, (op.height - 1) * CM, 0.04);
        door.rotation.y = -a;
        door.userData.z = [0, op.height];
        openings.add(door);
        planMarks.add(polyLine([leaf.hinge, end], 0.013, 0x374151, { closed: false }));
      }
    }
  }

  const cylGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 16);
  for (const f of model.fixtures) {
    const color = f.color ? new THREE.Color(f.color) : (MATERIAL_COLORS[f.material] ?? FIXTURE_COLORS[f.type] ?? 0xd1d5db);
    const clear = TRANSPARENT.has(f.type) || TRANSPARENT.has(f.material);
    const mat = new THREE.MeshLambertMaterial({ color, transparent: clear, opacity: clear ? 0.55 : 1 });
    const mesh = new THREE.Mesh(f.shape === 'cylinder' ? cylGeo : unitBox, mat);
    mesh.position.copy(v3(f.x, f.y, f.z + f.h / 2));
    mesh.scale.set(f.w * CM, Math.max(f.h, 0.3) * CM, f.d * CM);
    mesh.rotation.y = (-f.rot * Math.PI) / 180;
    mesh.userData.fixture = f;
    mesh.userData.z = [f.z, f.z + f.h];
    fixtures.add(mesh);
    if (f.shape !== 'cylinder' && f.collides && Math.min(f.w, f.d) > 3) {
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(unitBox), new THREE.LineBasicMaterial({ color: 0x9ca3af }));
      mesh.add(edges);
    }
    if (f.type === 'radiator' || f.type === 'boiler') {
      fixtureLabels.add(label(f.type === 'boiler' ? 'kombi' : 'petek', 'item', v3(f.x, f.y, f.z + f.h + 2)));
    }
    cuttables.push(mesh);
    // Kesit yüksekliğinin üstündekiler (kiriş, üst dolap, kombi) planda kesik çizgiyle gösterilir.
    if (f.z >= 120) aboveMarks.add(polyLine(f.poly, 1.25, 0x6b7280, { dashed: true }));
  }

  return { root, walls, floors, ceilings, openings, fixtures, planMarks, aboveMarks, roomLabels, fixtureLabels, cuttables };
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
}
