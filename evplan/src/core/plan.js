// plan.json → hesaplamaya hazır model (duvar parçaları, açıklıklar, odalar, sabit engeller).
// Birim: cm. Koordinat: x sağa, y aşağı. Yükseklik (z) yerden yukarı.

import {
  DEG,
  add,
  angleOf,
  bbox,
  dot,
  leftNormal,
  len,
  norm,
  polygonArea,
  polygonCentroid,
  pointInPolygon,
  rectCorners,
  scale,
  sectorPolygon,
  sub,
} from './geom.js';

const TOL = 1; // cm: uç noktaların "aynı" sayılacağı mesafe

export const DEFAULT_SETTINGS = {
  ceilingHeight: 260,
  eyeHeight: 160,
  passageMin: 75, // geçiş yolu hedefi (cm)
  passageHard: 60, // bunun altı kırmızı
  accessMin: 60, // mobilya önüne ulaşım
  gridStep: 2, // geçiş analizi ızgara adımı (cm)
  bodyHeight: 180, // yürüyen kişinin engellendiği yükseklik
};

function wallBand(side, t) {
  // Normal = yürüme yönüne göre sol. Bant: [oMin, oMax] (normal boyunca).
  if (side === 'left') return [0, t];
  if (side === 'right') return [-t, 0];
  return [-t / 2, t / 2];
}

function wallPoint(w, s, o) {
  return add(add(w.from, scale(w.d, s)), scale(w.n, o));
}

function bandPolygon(w, s0, s1, o0 = w.oMin, o1 = w.oMax) {
  return [wallPoint(w, s0, o0), wallPoint(w, s1, o0), wallPoint(w, s1, o1), wallPoint(w, s0, o1)];
}

/** Duvar ucunun, o uca değen diğer duvarın içine ne kadar uzaması gerektiği (köşe boşluğu kalmasın). */
function endExtension(w, atEnd, walls) {
  const p = atEnd ? w.to : w.from;
  const u = atEnd ? w.d : scale(w.d, -1);
  let ext = 0;
  for (const o of walls) {
    if (o === w) continue;
    const rel = sub(p, o.from);
    const s = dot(rel, o.d);
    const off = dot(rel, o.n);
    if (s < -TOL || s > o.len + TOL) continue;
    if (off < o.oMin - TOL || off > o.oMax + TOL) continue;
    const un = dot(u, o.n);
    if (Math.abs(un) < 0.3) continue; // aynı doğrultuda devam eden duvar
    const far = un > 0 ? o.oMax : o.oMin;
    const e = (far - off) / un;
    if (e > ext) ext = Math.min(e, 100);
  }
  return ext;
}

/**
 * Kapı/pencere kanadı: menteşe noktası, kapalıyken kanadın uzandığı yön, açılma yönü.
 * Döner: { hinge, closedDir, openDir, radius, a0, a1 } (açılar derece).
 */
function leafGeometry(hinge, closedDir, openDir, radius, openAngle) {
  const ac = angleOf(closedDir);
  const ao = angleOf(openDir);
  let diff = ao - ac;
  while (diff > 180) diff -= 360;
  while (diff <= -180) diff += 360;
  const sign = diff >= 0 ? 1 : -1;
  return { hinge, radius, a0: ac, a1: ac + sign * openAngle, sign, openAngle };
}

function openingLeaves(op, w) {
  const leaves = Math.max(1, op.leaves ?? 1);
  if (op.type === 'window' && !op.swing) return [];
  if (op.type === 'door' && op.swing === 'none') return [];
  const sideSign = op.swing === 'left' ? 1 : -1; // açıldığı taraf (normal yönünde +1)
  const face = op.swing === 'left' ? w.oMax : w.oMin;
  const inset = op.pivotInset ?? 0;
  const pivotO = face - sideSign * inset;
  const lw = op.leafWidth ?? op.width / leaves;
  const openAngle = op.openAngle ?? 90;
  const openDir = scale(w.n, sideSign);
  const out = [];
  for (let i = 0; i < leaves; i++) {
    const a = op.offset + (op.width / leaves) * i;
    const b = a + op.width / leaves;
    let hingeAtStart;
    if (leaves === 1) hingeAtStart = (op.hinge ?? 'start') === 'start';
    else hingeAtStart = i < leaves / 2;
    const hs = hingeAtStart ? a : b;
    const hinge = wallPoint(w, hs, pivotO);
    const closedDir = hingeAtStart ? w.d : scale(w.d, -1);
    out.push(leafGeometry(hinge, closedDir, openDir, lw, openAngle));
  }
  return out;
}

export function leafSector(leaf, segments = 12) {
  return sectorPolygon(leaf.hinge, leaf.radius, Math.min(leaf.a0, leaf.a1), Math.max(leaf.a0, leaf.a1), segments);
}

/**
 * Kanat belirli bir açıdayken ince dikdörtgen (çarpışma testi için).
 * Kalınlık, kanadın geldiği (kapalı) tarafa doğru verilir; böylece yan yana duran
 * dolapların kapakları komşuya "değiyor" sayılmaz.
 */
export function leafAt(leaf, angle, thickness = 4) {
  const a = leaf.a0 + leaf.sign * angle;
  const dir = [Math.cos(a * DEG), Math.sin(a * DEG)];
  const back = a - leaf.sign * 90;
  const perp = [Math.cos(back * DEG), Math.sin(back * DEG)];
  const mid = add(add(leaf.hinge, scale(dir, leaf.radius / 2)), scale(perp, thickness / 2));
  return rectCorners(mid[0], mid[1], leaf.radius, thickness, a);
}

export function buildPlanModel(plan) {
  const settings = { ...DEFAULT_SETTINGS, ...(plan.settings ?? {}) };
  const defaults = { wallThickness: 10, doorHeight: 205, ...(plan.defaults ?? {}) };
  const ceiling = settings.ceilingHeight;

  const walls = (plan.walls ?? []).map((src) => {
    const from = src.from;
    const to = src.to;
    const v = sub(to, from);
    const d = norm(v);
    const t = src.thickness ?? defaults.wallThickness;
    const [oMin, oMax] = wallBand(src.side ?? 'center', t);
    return {
      id: src.id,
      src,
      from,
      to,
      d,
      n: leftNormal(d),
      len: len(v),
      t,
      oMin,
      oMax,
      height: src.height ?? ceiling,
      kind: src.kind ?? (src.height && src.height < ceiling ? 'parapet' : 'wall'),
    };
  });
  for (const w of walls) {
    w.extStart = endExtension(w, false, walls);
    w.extEnd = endExtension(w, true, walls);
  }
  const wallById = new Map(walls.map((w) => [w.id, w]));

  const openings = [];
  for (const src of plan.openings ?? []) {
    const w = wallById.get(src.wall);
    if (!w) continue;
    const isDoor = src.type === 'door';
    const op = {
      ...src,
      sill: src.sill ?? (isDoor ? 0 : 90),
      height: src.height ?? (isDoor ? defaults.doorHeight : 150),
    };
    op.wallRef = w;
    op.s0 = op.offset;
    op.s1 = op.offset + op.width;
    op.top = Math.min(op.sill + op.height, w.height);
    op.portal = bandPolygon(w, op.s0, op.s1);
    op.center = wallPoint(w, (op.s0 + op.s1) / 2, (w.oMin + w.oMax) / 2);
    op.leaves = openingLeaves(op, w);
    op.zone = { z0: op.type === 'door' ? 0 : op.sill, z1: op.top };
    openings.push(op);
  }

  // Duvar parçaları: açıklıkların çevresi bölünür (lento, denizlik altı).
  const pieces = [];
  for (const w of walls) {
    const ops = openings.filter((o) => o.wallRef === w).sort((a, b) => a.s0 - b.s0);
    let s = -w.extStart;
    const push = (s0, s1, z0, z1, kind, opening) => {
      if (s1 - s0 < 0.01 || z1 - z0 < 0.01) return;
      pieces.push({ wall: w, s0, s1, z0, z1, kind, opening, poly: bandPolygon(w, s0, s1) });
    };
    for (const o of ops) {
      push(s, o.s0, 0, w.height, w.kind);
      if (o.sill > 0) push(o.s0, o.s1, 0, o.sill, 'sill', o);
      if (o.top < w.height) push(o.s0, o.s1, o.top, w.height, 'lintel', o);
      s = Math.max(s, o.s1);
    }
    push(s, w.len + w.extEnd, 0, w.height, w.kind);
  }

  const rooms = (plan.rooms ?? []).map((r) => {
    const b = bbox(r.polygon);
    return {
      ...r,
      poly: r.polygon,
      area: polygonArea(r.polygon) / 10000,
      bbox: b,
      center: polygonCentroid(r.polygon),
      isRect: r.polygon.length === 4,
      size: [b.maxX - b.minX, b.maxY - b.minY],
      ceilingHeight: r.ceilingHeight ?? ceiling,
    };
  });

  const fixtures = (plan.fixtures ?? []).map((f) => ({
    ...f,
    collides: f.collides !== false, // false: yalnızca görsel (fırın camı, ocak yüzeyi, lamba…)
    rot: f.rot ?? 0,
    z: f.z ?? 0,
    poly: rectCorners(f.x, f.y, f.w, f.d, f.rot ?? 0),
    z0: f.z ?? 0,
    z1: (f.z ?? 0) + f.h,
  }));

  const allPts = [...pieces.flatMap((p) => p.poly), ...rooms.flatMap((r) => r.poly)];
  const bounds = allPts.length ? bbox(allPts) : { minX: 0, minY: 0, maxX: 100, maxY: 100 };

  // Giriş: access.entranceDoor ya da entrance: true işaretli kapılar. Koridor henüz ölçülmediyse
  // odaların koridora açılan kapılarının hepsi giriş sayılabilir (geçiş analizi her birinden başlar).
  const flagged = openings.filter((o) => o.type === 'door' && o.entrance);
  const explicit = openings.find((o) => o.id === plan.access?.entranceDoor);
  // Daire kapısı belliyse önce o; ölçülmemiş alana açılan kapılar da geçiş analizine kaynak olarak eklenir.
  const entrances = explicit
    ? [explicit, ...flagged.filter((o) => o !== explicit)]
    : flagged.length
      ? flagged
      : openings.filter((o) => o.type === 'door').slice(0, 1);
  const entrance = entrances[0];
  const deliveryDoor = explicit ?? (flagged.length === 1 ? flagged[0] : null);

  return {
    plan,
    meta: plan.meta ?? {},
    settings,
    walls,
    pieces,
    openings,
    doors: openings.filter((o) => o.type === 'door'),
    windows: openings.filter((o) => o.type === 'window'),
    rooms,
    fixtures,
    bounds,
    entrance,
    entrances,
    deliveryDoor,
    access: plan.access ?? {},
  };
}

export function roomAt(model, p) {
  // İçbükey odalar için ışın testi; en küçük alanlı eşleşme (iç içe tanım varsa).
  let best = null;
  for (const r of model.rooms) {
    if (pointInPolygon(p, r.poly) && (!best || r.area < best.area)) best = r;
  }
  return best;
}

export { wallPoint, bandPolygon };
