// Yerleşimdeki mobilyalar: katalog kaydı + konum → çokgenler ve kullanım/açılma alanları.
// Yerel eksenler: x = genişlik (G), y = derinlik (D), +y = mobilyanın önü. Yükseklik (Y) z ekseni.

import { add, rectCorners, rotate, sectorPolygon, toLocal, toWorld } from './geom.js';

let uidCounter = 0;
export function newUid(prefix = 'm') {
  uidCounter += 1;
  return `${prefix}${Date.now().toString(36)}${uidCounter.toString(36)}`;
}

/**
 * Gerçek ürün seçenekleri: katalogda options = [{ name, part, values: [{ name, color | value }] }],
 * yerleşimde choice = { "Kumaş": "Sisli Yeşil", ... }. Döner: seçilen değerler, parça renkleri, varyant.
 */
export function resolveChoice(base, entryChoice) {
  if (!Array.isArray(base.options)) return { choice: null, parts: {}, variant: null };
  const choice = { ...(base.defaultOptions ?? {}), ...(entryChoice ?? {}) };
  const parts = {};
  const picked = [];
  // variantOptions: mağaza varyantını belirleyen seçenekler (ör. köşe yönü varyant değil, yerleşim seçimi).
  const keyed = new Set(base.variantOptions ?? base.options.map((o) => o.name));
  for (const opt of base.options) {
    const v = opt.values.find((x) => x.name === choice[opt.name]) ?? opt.values[0];
    choice[opt.name] = v.name;
    if (keyed.has(opt.name)) picked.push(v.name);
    if (opt.part) parts[opt.part] = v.color ?? v.value;
  }
  const variant = base.variants?.[picked.join(' / ')] ?? null;
  return { choice, parts, variant };
}

/** Katalog + yerleşim kaydını birleştirir. Yerleşimdeki alanlar katalogdakini ezer. */
export function resolveItem(entry, catalogById) {
  const base = entry.ref ? (catalogById.get(entry.ref) ?? {}) : {};
  const it = { ...base, ...entry };
  const { choice, parts, variant } = resolveChoice(base, entry.choice);
  const baseUrl = it.url ?? null;
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
    color: entry.color ?? parts.fabric ?? it.color ?? '#a0a4ab',
    url: baseUrl && variant ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}variant=${variant.id}` : baseUrl,
    brand: it.brand ?? null,
    options: Array.isArray(base.options) ? base.options : null,
    choice,
    parts,
    variant,
    shape: it.shape ?? null,
    dims: it.dims ?? null,
    material: it.material ?? null,
    source: it.source ?? null,
    model: it.model ?? null,
    modelRotation: it.modelRotation ?? 0,
    collides: it.collides !== false,
    movable: !!it.movable,
    flatpack: !!it.flatpack,
    onTop: !!it.onTop, // TV gibi: altındaki mobilyanın üstüne oturur (z otomatik)
    weight: it.weight ?? null, // kg
    maxTopLoad: it.maxTopLoad ?? null, // üst tablanın taşıyabileceği (kg)
    modules: Array.isArray(it.modules) && it.modules.length ? it.modules : null,
    group: it.group ?? null,
    price: variant?.price ?? it.price ?? null,
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

function makeLeaf(it, x0, x1, hingeLeft, openAngle, index) {
  const hx = hingeLeft ? x0 : x1;
  const hinge = toWorld([hx, it.d / 2], it.x, it.y, it.rot);
  const closedDir = rotate(hingeLeft ? [1, 0] : [-1, 0], it.rot);
  const openDir = rotate([0, 1], it.rot);
  const ac = (Math.atan2(closedDir[1], closedDir[0]) * 180) / Math.PI;
  const ao = (Math.atan2(openDir[1], openDir[0]) * 180) / Math.PI;
  let diff = ao - ac;
  while (diff > 180) diff -= 360;
  while (diff <= -180) diff += 360;
  const sign = diff >= 0 ? 1 : -1;
  return { hinge, radius: x1 - x0, a0: ac, a1: ac + sign * openAngle, sign, openAngle, index };
}

/**
 * Ön yüz satırının sütunları (yerel x, modül genişliği içinde): cols verilmişse onların genişlikleri,
 * yoksa count eşit sütun. Menteşe: tek kapakta hinge (varsayılan sol), çiftlerde dıştan (sol-sağ, sol-sağ…).
 */
export function rowColumns(w, row) {
  const cols = row.cols ?? Array.from({ length: row.count ?? 1 }, () => ({ type: row.type, w: w / (row.count ?? 1) }));
  const n = cols.length;
  let x = -w / 2;
  return cols.map((c, i) => {
    const x0 = x;
    x += c.w;
    let hinge = c.hinge ?? row.hinge;
    if (!hinge) hinge = n === 1 ? 'left' : n % 2 === 0 ? (i % 2 === 0 ? 'left' : 'right') : i < n / 2 ? 'left' : 'right';
    return { type: c.type ?? row.type, x0, x1: x, hinge };
  });
}

/** Ön kapakların her biri için kanat geometrisi (plan.js'deki kapı kanadıyla aynı şekil). */
export function frontLeaves(it) {
  if (it.modules) return moduleItems(it).flatMap(frontLeaves);
  if (it.module) {
    const out = [];
    for (const row of it.module.fronts ?? [])
      for (const c of rowColumns(it.w, row))
        if (c.type === 'door' || c.type === 'glass' || c.type === 'cane') out.push(makeLeaf(it, c.x0, c.x1, c.hinge === 'left', 90, out.length));
    return out;
  }
  const fd = it.frontDoors;
  if (!fd || !(fd.count > 0)) return [];
  const n = fd.count;
  const lw = it.w / n;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = -it.w / 2 + lw * i;
    let hingeLeft;
    if (n === 1) hingeLeft = (fd.hinge ?? 'left') === 'left';
    else if (fd.hinge === 'left') hingeLeft = true;
    else if (fd.hinge === 'right') hingeLeft = false;
    else hingeLeft = i < n / 2;
    out.push(makeLeaf(it, a, a + lw, hingeLeft, fd.openAngle ?? 90, i));
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

/** Tüm çekmece alanları (modüllü mobilyada modül başına). Her biri { poly, it } (it: ilgili modül). */
export function drawerZones(it) {
  const list = it.modules ? moduleItems(it) : [it];
  return list.map((m) => ({ poly: drawerZone(m), it: m })).filter((z) => z.poly);
}

/**
 * Modüllü mobilya (ör. TV ünitesi = boy dolap + sehpa + dolap): her modül kendi G×D×Y'si,
 * kapakları ve çekmeceleriyle sanal bir mobilya olarak döner. Modüller soldan sağa dizilir,
 * arkaları hizalıdır. fronts: alttan üste satırlar [{ type: door|glass|drawer|open|sliding|slidingGlass, h, count, hinge, depth }].
 */
export function moduleItems(it) {
  if (!it.modules) return [it];
  let x = -it.w / 2;
  return it.modules.map((m, i) => {
    const md = m.d ?? it.d;
    const cx = x + m.w / 2;
    x += m.w;
    const [wx, wy] = toWorld([cx, -it.d / 2 + md / 2], it.x, it.y, it.rot);
    const fronts = m.fronts ?? [];
    const drawer = fronts.find((f) => f.type === 'drawer');
    return {
      ...it,
      name: m.name ? `${it.name} (${m.name})` : it.name,
      x: wx,
      y: wy,
      w: m.w,
      d: md,
      h: m.h,
      z: it.z + (m.z ?? 0),
      frontDoors: null, // kanatlar module.fronts'tan (frontLeaves)
      drawers: drawer ? { depth: drawer.depth ?? Math.round(md * 0.8) } : null,
      use: null,
      modules: null,
      moduleIndex: i,
      module: m,
    };
  });
}

/**
 * L köşe koltuğun tabanı iki kanat: arkada tam genişlik × kanat derinliği, köşe tarafında kanat eni × kalan derinlik.
 * Köşe içi boş kalır (orta sehpa girebilir). parts.corner: 'left' (sol arka, varsayılan) | 'right'.
 */
export function wingItems(it) {
  const B = it.shape.wing ?? 91;
  const sx = it.parts?.corner === 'right' ? 1 : -1;
  const box = (lx, ly, w, d, i) => {
    const [x, y] = toWorld([lx, ly], it.x, it.y, it.rot);
    return { ...it, x, y, w, d, use: null, frontDoors: null, drawers: null, wingIndex: i };
  };
  return [box(0, -it.d / 2 + B / 2, it.w, B, 0), box(sx * (it.w / 2 - B / 2), B / 2, B, it.d - B, 1)];
}

/** Mobilyanın çakışma kutuları: modüllüyse her modül, L koltukta iki kanat, değilse kendisi. */
export function itemBoxes(it) {
  if (it.modules) return moduleItems(it);
  if (it.shape?.type === 'sofaL') return wingItems(it);
  return [it];
}

/** TV'nin oturacağı yer (yerel koordinat): modüllü ünitede en alçak modüllerin en genişinin ortası. */
export function tvSpot(it) {
  if (!it.modules) return [0, 0];
  const mods = moduleItems(it);
  const low = Math.min(...mods.map((m) => m.h));
  const lows = mods.filter((m) => m.h - low < 1);
  const [, ly] = toLocal([lows[0].x, lows[0].y], it.x, it.y, it.rot);
  if (lows.length === mods.length) return [0, ly]; // hepsi aynı yükseklikte: ortaya
  const best = lows.sort((a, b) => b.w - a.w)[0];
  return toLocal([best.x, best.y], it.x, it.y, it.rot);
}

/** onTop mobilyalar (TV…) altlarındaki en yüksek yüzeye oturur; açık z verilmişse ona dokunulmaz. */
export function stackItems(list) {
  for (const it of list) {
    if (!it.onTop || it.entry?.z !== undefined) continue;
    let top = null;
    for (const o of list) {
      if (o === it || !o.collides || o.onTop) continue;
      for (const b of itemBoxes(o)) {
        if (!pointInRect([it.x, it.y], b)) continue;
        const t = b.z + b.h;
        if (top === null || t > top) top = t;
      }
    }
    if (top !== null) it.z = top;
  }
  return list;
}

export function pointInRect(p, b) {
  const [lx, ly] = rotate([p[0] - b.x, p[1] - b.y], -b.rot);
  return Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.d / 2;
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
