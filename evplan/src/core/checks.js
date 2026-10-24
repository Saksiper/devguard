// "Sığar mı?" kontrolleri. Saf hesap: DOM/three.js yok, testlerde doğrudan çalışır.
//
// Önem dereceleri: error (kırmızı, fiziksel olarak olmaz), warn (turuncu, rahatsız eder),
// info (mavi, bilgi). Her bulgu ilgili mobilyaların uid'lerini ve plan üzerindeki konumunu taşır.

import { add, convexOverlap, dot, pointInPolygon, polygonCentroid, scale, sub } from './geom.js';
import { footprint, frontLeaves, drawerZone, useZones, sideFrame, SIDE_NAMES } from './items.js';
import { bandPolygon, leafAt, leafSector, roomAt } from './plan.js';
import { analyzePassage } from './passage.js';

const TOUCH = 0.5; // cm: bu kadarlık değme çakışma sayılmaz

const zOverlap = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0) > TOUCH;

function pieceLabel(p) {
  if (p.kind === 'sill') return 'pencere altı duvarı';
  if (p.kind === 'lintel') return 'kapı/pencere üstü';
  if (p.kind === 'parapet') return 'korkuluk duvarı';
  return 'duvar';
}

export function buildObstacles(model, items) {
  const walls = model.pieces.map((p) => ({
    kind: 'wall',
    label: pieceLabel(p),
    poly: p.poly,
    z0: p.z0,
    z1: p.z1,
  }));
  const fixtures = model.fixtures.map((f) => ({
    kind: 'fixture',
    id: f.id,
    label: f.name ?? f.type ?? 'sabit engel',
    poly: f.poly,
    z0: f.z0,
    z1: f.z1,
  }));
  const furn = items
    .filter((it) => it.collides)
    .map((it) => ({
      kind: 'item',
      uid: it.uid,
      label: it.name,
      poly: footprint(it),
      z0: it.z,
      z1: it.z + it.h,
      movable: it.movable,
    }));
  return { walls, fixtures, furn, all: [...walls, ...fixtures, ...furn] };
}

/** Sutherland–Hodgman: f(p) >= 0 yarı düzlemine kırp. */
function clip(poly, f) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const fp = f(p);
    const fq = f(q);
    if (fp >= 0) out.push(p);
    if (fp >= 0 !== fq >= 0) {
      const t = fp / (fp - fq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

/**
 * Mobilyanın bir kenarından dışarı doğru en yakın engele mesafe (cm).
 * Kenar boyunca uzanan şerit içinde kalan engel parçalarına bakılır (kesin hesap).
 */
export function sideDistance(frame, obstacles, maxDist = 500) {
  let best = { dist: maxDist, obstacle: null };
  for (const o of obstacles) {
    let poly = o.poly.map((p) => {
      const r = sub(p, frame.center);
      return [dot(r, frame.u), dot(r, frame.n)];
    });
    poly = clip(poly, (p) => p[0] + frame.half - 0.01);
    if (poly.length < 3) continue;
    poly = clip(poly, (p) => frame.half - 0.01 - p[0]);
    if (poly.length < 3) continue;
    poly = clip(poly, (p) => p[1] + 0.25);
    if (poly.length < 3) continue;
    const minV = Math.max(0, Math.min(...poly.map((p) => p[1])));
    if (minV < best.dist) best = { dist: minV, obstacle: o };
  }
  return best;
}

function pointSegDist(p, a, b) {
  const ab = sub(b, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / (dot(ab, ab) || 1)));
  const c = add(a, scale(ab, t));
  return Math.hypot(p[0] - c[0], p[1] - c[1]);
}

function polyDist(p, poly) {
  if (pointInPolygon(p, poly)) return 0;
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) d = Math.min(d, pointSegDist(p, poly[i], poly[(i + 1) % poly.length]));
  return d;
}

/** Kanat 0°'den açılırken ilk çarptığı açı. Çarpmıyorsa openAngle. */
function sweepLeaf(leaf, obstacles, step = 2) {
  const sector = leafSector(leaf);
  const hits = obstacles.filter((o) => convexOverlap(sector, o.poly) > TOUCH);
  if (!hits.length) return { max: leaf.openAngle, by: null };
  for (let a = step; a <= leaf.openAngle + 1e-9; a += step) {
    const rect = leafAt(leaf, Math.min(a, leaf.openAngle));
    const hit = hits.find((o) => convexOverlap(rect, o.poly) > TOUCH);
    if (hit) return { max: Math.max(0, a - step), by: hit };
  }
  return { max: leaf.openAngle, by: null };
}

function shrink(poly, k = 0.5) {
  const c = polygonCentroid(poly);
  return poly.map((p) => {
    const v = sub(p, c);
    const l = Math.hypot(v[0], v[1]) || 1;
    return add(p, scale(v, -k / l));
  });
}

const fmt = (v) => `${Math.round(v)} cm`;

/**
 * @returns {{ issues, passage, metrics, itemState: Map<uid, 'error'|'warn'|null> }}
 */
export function runChecks(model, items, { passage = true } = {}) {
  const S = model.settings;
  const issues = [];
  const push = (severity, kind, text, extra = {}) => issues.push({ severity, kind, text, items: [], ...extra });
  const obs = buildObstacles(model, items);
  const byUid = new Map(items.map((it) => [it.uid, it]));

  // 1) Çakışma: mobilya ↔ duvar / sabit engel / mobilya; ev dışı.
  for (const it of items) {
    if (!it.collides) continue;
    const fp = footprint(it);
    const z0 = it.z;
    const z1 = it.z + it.h;
    for (const o of [...obs.walls, ...obs.fixtures]) {
      if (!zOverlap(z0, z1, o.z0, o.z1)) continue;
      const ov = convexOverlap(fp, o.poly);
      if (ov > TOUCH)
        push('error', 'collision', `${it.name} ${o.label} ile çakışıyor (≈${fmt(ov)}).`, {
          items: [it.uid],
          at: polygonCentroid(o.poly),
        });
    }
    if (model.rooms.length) {
      const inside = shrink(fp).every((p) => model.rooms.some((r) => pointInPolygon(p, r.poly)));
      if (!inside) {
        const room = roomAt(model, [it.x, it.y]);
        push('error', 'outside', `${it.name} oda sınırının dışına taşıyor${room ? ` (${room.name})` : ''}.`, {
          items: [it.uid],
          at: [it.x, it.y],
        });
      }
    }
  }
  for (let i = 0; i < obs.furn.length; i++) {
    for (let j = i + 1; j < obs.furn.length; j++) {
      const a = obs.furn[i];
      const b = obs.furn[j];
      if (a.movable || b.movable) continue; // sandalye masanın altına girebilir
      if (!zOverlap(a.z0, a.z1, b.z0, b.z1)) continue;
      const ov = convexOverlap(a.poly, b.poly);
      if (ov > TOUCH)
        push('error', 'collision', `${a.label} ile ${b.label} üst üste (≈${fmt(ov)}).`, {
          items: [a.uid, b.uid],
          at: polygonCentroid([...a.poly, ...b.poly]),
        });
    }
  }

  // 2) Evin kapıları ve pencere kanatları: mobilyalar yüzünden tam açılıyor mu?
  const swingBlockers = new Map(); // kapı id → engelleyen uid'ler
  for (const op of model.openings) {
    const name = op.name ?? (op.type === 'door' ? `Kapı ${op.id}` : `Pencere ${op.id}`);
    const rel = obs.furn.filter((o) => zOverlap(op.zone.z0, op.zone.z1, o.z0, o.z1));
    let worst = null;
    for (const leaf of op.leaves) {
      const r = sweepLeaf(leaf, rel);
      if (r.by && (!worst || r.max < worst.max)) worst = { ...r, leaf };
    }
    if (!worst) continue;
    swingBlockers.set(op.id, new Set([worst.by.uid]));
    const sev = op.type === 'door' ? 'error' : 'warn';
    const what = op.type === 'door' ? '' : ' (kanat)';
    push(sev, 'swing', `${name}${what}: ${worst.by.label} yüzünden en fazla ${Math.round(worst.max)}° açılıyor (gereken ${worst.leaf.openAngle}°).`, {
      items: [worst.by.uid],
      at: worst.leaf.hinge,
      opening: op.id,
    });
  }

  // 2b) Kapı önü: kapı boşluğunun iki yanındaki 40 cm'lik bantta mobilya net geçişi daraltıyor mu?
  for (const d of model.doors) {
    const w = d.wallRef;
    const band = bandPolygon(w, d.s0, d.s1, w.oMin - 40, w.oMax + 40);
    const blocked = [];
    for (const o of obs.furn) {
      if (o.movable || o.z0 >= d.top || convexOverlap(band, o.poly) <= TOUCH) continue;
      const ss = o.poly.map((p) => dot(sub(p, w.from), w.d));
      blocked.push({ a: Math.max(d.s0, Math.min(...ss)), b: Math.min(d.s1, Math.max(...ss)), o });
    }
    if (!blocked.length) continue;
    blocked.sort((p, q) => p.a - q.a);
    let free = 0;
    let cur = d.s0;
    for (const bl of blocked) {
      free = Math.max(free, bl.a - cur);
      cur = Math.max(cur, bl.b);
    }
    free = Math.max(free, d.s1 - cur);
    if (free >= d.width - 1) continue;
    const others = blocked.filter((bl) => !swingBlockers.get(d.id)?.has(bl.o.uid));
    if (!others.length && free > 0) continue; // aynı mobilya zaten "kapı açılmıyor" olarak raporlandı
    const name = d.name ?? `Kapı ${d.id}`;
    push(free < S.passageHard ? 'error' : 'warn', 'doorway', `${name}: ${blocked.map((bl) => bl.o.label).join(', ')} kapı önünü daraltıyor, net geçiş ≈${fmt(free)} (kapı ${fmt(d.width)}).`, {
      items: blocked.map((bl) => bl.o.uid),
      at: d.center,
    });
  }

  // 3) Mobilyanın kendi kapakları / çekmeceleri.
  for (const it of items) {
    const others = obs.all.filter((o) => o.uid !== it.uid && !o.movable && zOverlap(it.z, it.z + it.h, o.z0, o.z1));
    for (const leaf of frontLeaves(it)) {
      const { max, by } = sweepLeaf(leaf, others);
      if (by)
        push('error', 'front', `${it.name}: ${leaf.index + 1}. kapak ${by.label} yüzünden en fazla ${Math.round(max)}° açılıyor.`, {
          items: [it.uid, by.uid].filter(Boolean),
          at: leaf.hinge,
        });
    }
    const dz = drawerZone(it);
    if (dz) {
      const frame = { center: polygonCentroid([dz[0], dz[1]]), u: sub(dz[1], dz[0]), n: sub(dz[3], dz[0]) };
      const ul = Math.hypot(...frame.u);
      const nl = Math.hypot(...frame.n);
      frame.u = scale(frame.u, 1 / ul);
      frame.n = scale(frame.n, 1 / nl);
      frame.half = ul / 2;
      const { dist, obstacle } = sideDistance(frame, others, it.drawers.depth + 1);
      if (obstacle && dist < it.drawers.depth - TOUCH)
        push('error', 'front', `${it.name}: çekmeceler ${fmt(it.drawers.depth)} gerektiriyor, ${obstacle.label} yüzünden ${fmt(dist)} açılıyor.`, {
          items: [it.uid, obstacle.uid].filter(Boolean),
          at: polygonCentroid(dz),
        });
    }
  }

  // 4) Kullanım alanı (yatak yanı, masa önü...): uyarı.
  const bodyObs = obs.all.filter((o) => o.z0 < S.bodyHeight && !o.movable);
  for (const it of items) {
    for (const zone of useZones(it)) {
      const others = bodyObs.filter((o) => o.uid !== it.uid);
      const { dist, obstacle } = sideDistance(zone.frame, others, zone.need + 1);
      if (obstacle && dist < zone.need - 1)
        push('warn', 'use', `${it.name} ${SIDE_NAMES[zone.side]} için ${fmt(zone.need)} önerilir, ${fmt(dist)} var (${obstacle.label}).`, {
          items: [it.uid, obstacle.uid].filter(Boolean),
          at: polygonCentroid(zone.poly),
        });
    }
  }

  // 5) Teslimat: giriş kapısından / asansörden geçer mi (yaklaşık).
  const ent = model.entrance;
  const lift = model.access?.elevator;
  for (const it of items) {
    if (it.flatpack || it.entry?.delivered) continue;
    const [a, b, c] = [it.w, it.d, it.h].sort((p, q) => p - q);
    if (ent) {
      const W = ent.width;
      const H = ent.height;
      if (!(a <= W - 2 && b <= H - 2))
        push('warn', 'delivery', `${it.name} (kesit ${Math.round(a)}×${Math.round(b)} cm) giriş kapısından (${W}×${H}) düz geçmeyebilir.`, {
          items: [it.uid],
          at: ent.center,
        });
    }
    if (lift && lift.cabinWidth) {
      const cab = [lift.cabinWidth, lift.cabinDepth, lift.cabinHeight].sort((p, q) => p - q);
      const straight = a <= cab[0] && b <= cab[1] && c <= cab[2];
      const diag = a <= cab[0] && b <= cab[1] && c <= Math.hypot(cab[1], cab[2]);
      const door = a <= (lift.doorWidth ?? Infinity) && b <= (lift.doorHeight ?? Infinity);
      if (!door || !diag)
        push('warn', 'delivery', `${it.name} asansöre sığmayabilir (${Math.round(a)}×${Math.round(b)}×${Math.round(c)}).`, {
          items: [it.uid],
          at: ent?.center ?? [it.x, it.y],
        });
      else if (!straight)
        push('info', 'delivery', `${it.name} asansöre ancak eğik/dik sığar.`, { items: [it.uid], at: ent?.center ?? [it.x, it.y] });
    }
  }

  // 6) Geçiş yolları: girişten her kapıya ve mobilya önlerine en geniş yol.
  let pass = null;
  if (passage && model.entrance) {
    const fixedObs = [...obs.walls, ...obs.fixtures].filter((o) => o.z0 < S.bodyHeight);
    const itemObs = obs.furn.filter((o) => o.z0 < S.bodyHeight && !o.movable);
    const targets = [];
    for (const d of model.doors) {
      if (d === model.entrance) continue;
      targets.push({ id: d.id, kind: 'door', label: d.name ?? `Kapı ${d.id}`, region: d.portal, threshold: S.passageMin });
    }
    const useWarned = new Set(issues.filter((i) => i.kind === 'use').map((i) => i.items[0]));
    for (const it of items) {
      if (it.movable || !it.collides) continue;
      const z = useZones(it).sort((p, q) => q.need - p.need)[0];
      if (!z) continue;
      // Mobilyanın kendisi yolu daraltmasın diye hedef, önündeki (erişim/2 … +15 cm) bant.
      const f = z.frame;
      const a0 = S.accessMin / 2;
      const a1 = a0 + 15;
      const e = (k) => add(f.center, scale(f.u, k * f.half));
      const region = [
        add(e(-1), scale(f.n, a0)),
        add(e(1), scale(f.n, a0)),
        add(e(1), scale(f.n, a1)),
        add(e(-1), scale(f.n, a1)),
      ];
      targets.push({ id: it.uid, kind: 'item', label: `${it.name} önü`, region, threshold: S.accessMin, uid: it.uid, skip: useWarned.has(it.uid) });
    }
    pass = analyzePassage(model, { fixed: fixedObs, items: itemObs }, targets);
    if (pass) {
      const groups = [];
      for (const r of pass.results) {
        if (r.kind === 'item' && r.skip) continue;
        if (!r.reachable) {
          push(r.kind === 'door' ? 'error' : 'warn', 'passage', `${r.label}: girişten ${r.threshold} cm genişlikte değil, hiç ulaşılamıyor.`, {
            items: r.uid ? [r.uid] : [],
            at: polygonCentroid(r.region),
          });
          continue;
        }
        if (r.width >= r.threshold) continue;
        const structural = r.baseWidth !== null && r.baseWidth - r.width < 2;
        const near = itemObs.filter((o) => polyDist(r.bottleneck, o.poly) <= r.width / 2 + 3);
        const fixedNear = fixedObs.filter((o) => polyDist(r.bottleneck, o.poly) <= r.width / 2 + 3);
        const g = groups.find((x) => Math.hypot(x.at[0] - r.bottleneck[0], x.at[1] - r.bottleneck[1]) < 25);
        if (g) {
          g.labels.push(r.label);
          g.width = Math.min(g.width, r.width);
          continue;
        }
        groups.push({
          at: r.bottleneck,
          width: r.width,
          threshold: r.threshold,
          labels: [r.label],
          structural,
          kind: r.kind,
          culprits: [...new Set([...near, ...fixedNear].map((o) => o.label))],
          uids: near.map((o) => o.uid),
        });
      }
      for (const g of groups) {
        const between = g.culprits.length ? ` (${g.culprits.slice(0, 3).join(' – ')} arası)` : '';
        let sev = g.width < S.passageHard ? 'error' : 'warn';
        if (g.kind === 'item') sev = 'warn';
        if (g.structural) sev = 'info';
        const what = g.structural ? 'evin kendi yapısı dar' : 'en dar yer';
        push(sev, 'passage', `${g.labels.join(', ')} yolunda ${what}: ≈${fmt(g.width)} (hedef ${fmt(g.threshold)})${between}.`, {
          items: g.uids,
          at: g.at,
        });
      }
    }
  }

  // Özet metrikler (yerleşim karşılaştırması için).
  const doorWidths = pass ? pass.results.filter((r) => r.kind === 'door').map((r) => r.width) : [];
  const roomArea = model.rooms.reduce((s, r) => s + r.area, 0);
  const itemArea = items.filter((it) => it.collides).reduce((s, it) => s + (it.w * it.d) / 10000, 0);
  const metrics = {
    errors: issues.filter((i) => i.severity === 'error').length,
    warnings: issues.filter((i) => i.severity === 'warn').length,
    minPassage: doorWidths.length ? Math.min(...doorWidths) : null,
    itemCount: items.length,
    itemArea,
    roomArea,
    freePct: roomArea ? Math.max(0, 100 * (1 - itemArea / roomArea)) : null,
    roomFree: pass?.roomFree ?? null,
  };

  const itemState = new Map();
  const rank = { error: 2, warn: 1, info: 0 };
  for (const is of issues) {
    for (const uid of is.items) {
      if (!uid || !byUid.has(uid) || is.severity === 'info') continue;
      const cur = itemState.get(uid);
      if (!cur || rank[is.severity] > rank[cur]) itemState.set(uid, is.severity);
    }
  }
  const order = { error: 0, warn: 1, info: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);
  return { issues, passage: pass, metrics, itemState };
}

/** Seçili mobilyanın dört kenarından en yakın engele mesafeler (plan görünümünde ölçü çizgisi). */
export function itemDistances(model, items, it) {
  const obs = buildObstacles(model, items).all.filter((o) => o.uid !== it.uid && zOverlap(it.z, it.z + it.h, o.z0, o.z1));
  const out = [];
  for (const side of ['front', 'back', 'left', 'right']) {
    const frame = sideFrame(it, side);
    const { dist, obstacle } = sideDistance(frame, obs, 400);
    if (obstacle) out.push({ side, from: frame.center, to: add(frame.center, scale(frame.n, dist)), dist, label: obstacle.label });
  }
  return out;
}
