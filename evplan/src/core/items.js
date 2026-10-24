// Yerleşimdeki mobilyalar: katalog kaydı + konum → çokgenler ve kullanım/açılma alanları.
// Yerel eksenler: x = genişlik (G), y = derinlik (D), +y = mobilyanın önü. Yükseklik (Y) z ekseni.

import { add, rectCorners, rotate, sectorPolygon, toWorld } from './geom.js';

let uidCounter = 0;
export function newUid(prefix = 'm') {
  uidCounter += 1;
  return `${prefix}${Date.now().toString(36)}${uidCounter.toString(36)}`;
}

/** Katalog + yerleşim kaydını birleştirir. Yerleşimdeki alanlar katalogdakini ezer. */
export function resolveItem(entry, catalogById) {
  const base = entry.ref ? (catalogById.get(entry.ref) ?? {}) : {};
  const it = { ...base, ...entry };
  return {
    uid: entry.uid,
    ref: entry.ref ?? null,
    name: it.name ?? entry.ref ?? 'Mobilya',
    category: it.category ?? '',
    w: it.w,
    d: it.d,
    h: it.h,
    z: it.z ?? 0,
    x: entry.x,
    y: entry.y,
    rot: entry.rot ?? 0,
    color: it.color ?? '#a0a4ab',
    url: it.url ?? null,
    model: it.model ?? null,
    modelRotation: it.modelRotation ?? 0,
    collides: it.collides !== false,
    movable: !!it.movable,
    flatpack: !!it.flatpack,
    frontDoors: it.frontDoors ?? null,
    drawers: it.drawers ?? null,
    use: it.use ?? null,
    assumed: !!it.assumed,
    notes: it.notes ?? '',
    entry,
  };
}

export function footprint(it) {
  return rectCorners(it.x, it.y, it.w, it.d, it.rot);
}

/** Ön kapakların her biri için kanat geometrisi (plan.js'deki kapı kanadıyla aynı şekil). */
export function frontLeaves(it) {
  const fd = it.frontDoors;
  if (!fd || !(fd.count > 0)) return [];
  const n = fd.count;
  const lw = it.w / n;
  const openAngle = fd.openAngle ?? 90;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = -it.w / 2 + lw * i;
    const b = a + lw;
    let hingeLeft;
    if (n === 1) hingeLeft = (fd.hinge ?? 'left') === 'left';
    else if (fd.hinge === 'left') hingeLeft = true;
    else if (fd.hinge === 'right') hingeLeft = false;
    else hingeLeft = i < n / 2;
    const hx = hingeLeft ? a : b;
    const hinge = toWorld([hx, it.d / 2], it.x, it.y, it.rot);
    const closedLocal = hingeLeft ? [1, 0] : [-1, 0];
    const closedDir = rotate(closedLocal, it.rot);
    const openDir = rotate([0, 1], it.rot);
    const ac = (Math.atan2(closedDir[1], closedDir[0]) * 180) / Math.PI;
    const ao = (Math.atan2(openDir[1], openDir[0]) * 180) / Math.PI;
    let diff = ao - ac;
    while (diff > 180) diff -= 360;
    while (diff <= -180) diff += 360;
    const sign = diff >= 0 ? 1 : -1;
    out.push({ hinge, radius: lw, a0: ac, a1: ac + sign * openAngle, sign, openAngle, index: i });
  }
  return out;
}

export function leafPolygon(leaf, segments = 10) {
  return sectorPolygon(leaf.hinge, leaf.radius, Math.min(leaf.a0, leaf.a1), Math.max(leaf.a0, leaf.a1), segments);
}

export function drawerZone(it) {
  const dr = it.drawers;
  if (!dr || !(dr.depth > 0)) return null;
  const local = [
    [-it.w / 2, it.d / 2],
    [it.w / 2, it.d / 2],
    [it.w / 2, it.d / 2 + dr.depth],
    [-it.w / 2, it.d / 2 + dr.depth],
  ];
  return local.map((p) => toWorld(p, it.x, it.y, it.rot));
}

const SIDES = {
  front: { n: [0, 1], u: [1, 0], half: (it) => it.w / 2, off: (it) => it.d / 2 },
  back: { n: [0, -1], u: [1, 0], half: (it) => it.w / 2, off: (it) => it.d / 2 },
  left: { n: [-1, 0], u: [0, 1], half: (it) => it.d / 2, off: (it) => it.w / 2 },
  right: { n: [1, 0], u: [0, 1], half: (it) => it.d / 2, off: (it) => it.w / 2 },
};

export const SIDE_NAMES = { front: 'önü', back: 'arkası', left: 'sol yanı', right: 'sağ yanı' };

/** Bir kenarın dünya koordinatındaki çerçevesi: merkez, kenar boyunca u, dışa doğru normal n. */
export function sideFrame(it, side) {
  const s = SIDES[side];
  const nLocal = s.n;
  const centerLocal = [nLocal[0] * s.off(it), nLocal[1] * s.off(it)];
  return {
    side,
    center: toWorld(centerLocal, it.x, it.y, it.rot),
    u: rotate(s.u, it.rot),
    n: rotate(nLocal, it.rot),
    half: s.half(it),
  };
}

/**
 * Kullanım alanları. use = { front, back, left, right } (cm) ve isteğe bağlı sideFrom (0–1):
 * yan alanlar arka kenardan bu oranda ileriden başlar (ör. yatakta komodinlerin durduğu baş kısmı hariç).
 */
export function useZones(it) {
  if (!it.use) return [];
  const out = [];
  for (const side of Object.keys(SIDES)) {
    const need = it.use[side];
    if (!(need > 0)) continue;
    const f = sideFrame(it, side);
    const from = it.use.sideFrom ?? 0;
    if ((side === 'left' || side === 'right') && from > 0) {
      const start = -f.half + 2 * f.half * from;
      const mid = (start + f.half) / 2;
      f.center = add(f.center, [f.u[0] * mid, f.u[1] * mid]);
      f.half = (f.half - start) / 2;
    }
    const a = add(f.center, [f.u[0] * -f.half, f.u[1] * -f.half]);
    const b = add(f.center, [f.u[0] * f.half, f.u[1] * f.half]);
    const poly = [a, b, add(b, [f.n[0] * need, f.n[1] * need]), add(a, [f.n[0] * need, f.n[1] * need])];
    out.push({ side, need, poly, frame: f });
  }
  return out;
}
