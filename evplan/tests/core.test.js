import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { convexOverlap, pointInPolygon, rectCorners } from '../src/core/geom.js';
import { buildPlanModel, leafSector } from '../src/core/plan.js';
import { resolveItem, useZones } from '../src/core/items.js';
import { itemDistances, runChecks } from '../src/core/checks.js';
import { validateLayout, validatePlan } from '../src/core/validate.js';

// 400 × 300 iç ölçülü tek oda + 120 cm'lik koridor; dış duvar 20, iç duvar 10 cm.
//  y=0   ┌──────────── oda ────────────┐
//  y=300 ├──── kapı (x 160–240) ───────┤  iç duvar (300–310)
//  y=310 │          koridor            │  giriş kapısı doğu duvarında
//  y=430 └─────────────────────────────┘
function testPlan(extra = {}) {
  return {
    meta: { name: 'test' },
    settings: { ceilingHeight: 260, passageMin: 75, passageHard: 60, accessMin: 60, gridStep: 2 },
    walls: [
      { id: 'N', from: [0, 0], to: [400, 0], thickness: 20, side: 'left' },
      { id: 'E', from: [400, 0], to: [400, 430], thickness: 20, side: 'left' },
      { id: 'S', from: [400, 430], to: [0, 430], thickness: 20, side: 'left' },
      { id: 'W', from: [0, 430], to: [0, 0], thickness: 20, side: 'left' },
      { id: 'I', from: [0, 300], to: [400, 300], thickness: 10, side: 'right' },
    ],
    openings: [
      { id: 'giris', type: 'door', wall: 'E', offset: 320, width: 90, hinge: 'end', swing: 'right', entrance: true },
      { id: 'oda', type: 'door', wall: 'I', offset: 160, width: 80, hinge: 'start', swing: 'left' },
      { id: 'p', type: 'window', wall: 'N', offset: 100, width: 120, sill: 90, height: 140, leaves: 2, swing: 'right' },
    ],
    rooms: [
      { id: 'oda', name: 'Oda', polygon: [[0, 0], [400, 0], [400, 300], [0, 300]] },
      { id: 'kor', name: 'Koridor', polygon: [[0, 310], [400, 310], [400, 430], [0, 430]] },
    ],
    fixtures: [{ id: 'petek', type: 'radiator', name: 'Petek', x: 160, y: 9, w: 100, d: 10, h: 60, z: 15 }],
    ...extra,
  };
}

const catalog = new Map(
  [
    { id: 'kutu', name: 'Kutu', w: 100, d: 50, h: 80 },
    { id: 'yuksek', name: 'Dolap', w: 100, d: 60, h: 200, frontDoors: { count: 2 } },
    { id: 'masa', name: 'Masa', w: 120, d: 80, h: 75, use: { front: 70 } },
    { id: 'sandalye', name: 'Sandalye', w: 45, d: 50, h: 90, movable: true },
    { id: 'hali', name: 'Halı', w: 200, d: 150, h: 1, collides: false },
  ].map((i) => [i.id, i]),
);

const items = (...entries) => entries.map((e, k) => resolveItem({ uid: `u${k}`, ...e }, catalog));
const kinds = (r, sev) => r.issues.filter((i) => !sev || i.severity === sev).map((i) => i.kind);

describe('geometri', () => {
  it('döndürülmüş dikdörtgen köşeleri ve SAT çakışması', () => {
    const a = rectCorners(0, 0, 100, 50, 90);
    expect(a.map((p) => p.map((v) => Math.round(v)))).toEqual([
      [25, -50],
      [25, 50],
      [-25, 50],
      [-25, -50],
    ]);
    expect(convexOverlap(rectCorners(0, 0, 10, 10), rectCorners(9, 0, 10, 10))).toBeCloseTo(1);
    expect(convexOverlap(rectCorners(0, 0, 10, 10), rectCorners(11, 0, 10, 10))).toBeLessThan(0);
    expect(pointInPolygon([5, 5], rectCorners(0, 0, 20, 20))).toBe(true);
  });
});

describe('plan modeli', () => {
  const m = buildPlanModel(testPlan());

  it('duvarları kapı/pencere etrafında böler', () => {
    const iPieces = m.pieces.filter((p) => p.wall.id === 'I');
    // kapının solu, kapı üstü (lento), kapının sağı
    expect(iPieces.map((p) => p.kind)).toEqual(['wall', 'lintel', 'wall']);
    const nPieces = m.pieces.filter((p) => p.wall.id === 'N').map((p) => p.kind);
    expect(nPieces).toEqual(['wall', 'sill', 'lintel', 'wall']);
  });

  it('köşelerde boşluk bırakmaz (dış köşe karesi dolu)', () => {
    const corner = [410, -10]; // K-D dış köşesi
    expect(m.pieces.some((p) => pointInPolygon(corner, p.poly))).toBe(true);
  });

  it('kapı kanadı menteşe ve açılma çeyreği doğru', () => {
    const d = m.openings.find((o) => o.id === 'oda');
    const leaf = d.leaves[0];
    expect(leaf.hinge).toEqual([160, 300]); // odanın yüzünde, başlangıç tarafında
    const sector = leafSector(leaf);
    // Oda tarafına (yukarı) açılır: dilim y <= 300, x ∈ [160, 240]
    for (const [x, y] of sector) {
      expect(y).toBeLessThanOrEqual(300.001);
      expect(x).toBeGreaterThanOrEqual(159.999);
      expect(x).toBeLessThanOrEqual(240.001);
    }
  });
});

describe('kontroller', () => {
  const m = buildPlanModel(testPlan());

  it('boş ev: sorun yok', () => {
    const r = runChecks(m, []);
    expect(r.issues.filter((i) => i.severity !== 'info')).toEqual([]);
    expect(r.metrics.minPassage).toBeGreaterThan(75);
  });

  it('duvara ve peteğe çakışma', () => {
    const r = runChecks(m, items({ ref: 'kutu', x: 60, y: 20, rot: 0 }), { passage: false });
    expect(kinds(r, 'error')).toContain('collision'); // dış duvar
    const r2 = runChecks(m, items({ ref: 'kutu', x: 160, y: 35, rot: 0 }), { passage: false }); // y 10–60, petek 4–14
    expect(r2.issues.some((i) => i.text.includes('Petek'))).toBe(true);
  });

  it('peteğin üstündeki yüksekliğe konan raf çakışmaz (3B kontrol)', () => {
    const r = runChecks(m, items({ ref: 'kutu', x: 160, y: 30, z: 80, h: 30 }), { passage: false });
    expect(r.issues.some((i) => i.text.includes('Petek'))).toBe(false);
  });

  it('mobilya üst üste; sandalye masanın altına girebilir', () => {
    const r = runChecks(m, items({ ref: 'kutu', x: 100, y: 100 }, { ref: 'kutu', x: 150, y: 100 }), { passage: false });
    expect(kinds(r, 'error')).toContain('collision');
    const r2 = runChecks(m, items({ ref: 'masa', x: 100, y: 100 }, { ref: 'sandalye', x: 100, y: 140 }), { passage: false });
    expect(kinds(r2, 'error')).not.toContain('collision');
  });

  it('halı çakışma sayılmaz', () => {
    const r = runChecks(m, items({ ref: 'hali', x: 150, y: 150 }, { ref: 'kutu', x: 150, y: 150 }), { passage: false });
    expect(kinds(r, 'error')).toEqual([]);
  });

  it('kapı açılma alanına konan mobilya: en fazla açılma açısı raporlanır', () => {
    // Oda kapısının dilimi: x 160–240, y 220–300. Kutu tam ortasında.
    const r = runChecks(m, items({ ref: 'kutu', x: 200, y: 260 }), { passage: false });
    const sw = r.issues.find((i) => i.kind === 'swing' && i.opening === 'oda');
    expect(sw?.severity).toBe('error');
    expect(sw.text).toMatch(/en fazla \d+°/);
  });

  it('pencere kanadı: alçak mobilya engel olmaz, yüksek dolap olur', () => {
    const low = runChecks(m, items({ ref: 'kutu', x: 160, y: 50 }), { passage: false });
    expect(low.issues.filter((i) => i.kind === 'swing')).toEqual([]);
    const tall = runChecks(m, items({ ref: 'yuksek', x: 160, y: 45, rot: 0 }), { passage: false });
    expect(tall.issues.some((i) => i.kind === 'swing' && i.opening === 'p')).toBe(true);
  });

  it('dolap kapakları önündeki mobilya yüzünden açılmıyor', () => {
    const r = runChecks(m, items({ ref: 'yuksek', x: 330, y: 150, rot: 270 }, { ref: 'kutu', x: 260, y: 150, rot: 90 }), { passage: false });
    expect(r.issues.some((i) => i.kind === 'front' && i.text.includes('kapak'))).toBe(true);
  });

  it('koridoru daraltan mobilya: geçiş genişliği ölçülür', () => {
    // Koridor 120 cm; 60 cm derin kutu koridoru ≈60 cm'ye düşürür.
    const r = runChecks(m, items({ ref: 'kutu', x: 300, y: 400, rot: 0, d: 60 }));
    const p = r.issues.find((i) => i.kind === 'passage');
    expect(p).toBeTruthy();
    const width = Number(p.text.match(/≈(\d+) cm/)[1]);
    expect(Math.abs(width - 60)).toBeLessThanOrEqual(3);
    expect(['warn', 'error']).toContain(p.severity);
  });

  it('kullanım alanı uyarısı (masa önü)', () => {
    const r = runChecks(m, items({ ref: 'masa', x: 200, y: 80, rot: 0 }, { ref: 'kutu', x: 200, y: 170 }), { passage: false });
    const u = r.issues.find((i) => i.kind === 'use');
    expect(u?.severity).toBe('warn');
    expect(u.text).toMatch(/70 cm önerilir, (\d+) cm var/);
  });

  it('kenar mesafeleri (seçili mobilya ölçü çizgileri)', () => {
    const list = items({ ref: 'kutu', x: 100, y: 100, rot: 0 });
    const d = itemDistances(m, list, list[0]);
    const left = d.find((x) => x.side === 'left');
    expect(Math.round(left.dist)).toBe(50); // x=50 kenarından x=0 duvarına
  });

  it('kullanım alanı sideFrom ile yalnızca ayak tarafını kapsar', () => {
    const bed = resolveItem({ uid: 'b', w: 160, d: 200, h: 50, x: 0, y: 0, use: { left: 60, sideFrom: 0.5 } }, new Map());
    const z = useZones(bed)[0];
    const ys = z.poly.map((p) => p[1]);
    expect(Math.min(...ys)).toBeCloseTo(0);
    expect(Math.max(...ys)).toBeCloseTo(100);
  });
});

describe('demo verisi', () => {
  const dir = path.resolve(__dirname, '../public/data/demo');
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
  const cat = JSON.parse(fs.readFileSync(path.join(dir, '../furniture.json'), 'utf8'));
  const byId = new Map(cat.items.map((i) => [i.id, i]));
  const model = buildPlanModel(plan);
  const load = (f) => JSON.parse(fs.readFileSync(path.join(dir, 'layouts', f), 'utf8'));

  it('plan ve yerleşimler doğrulamadan geçer', () => {
    expect(validatePlan(plan).errors).toEqual([]);
    for (const f of ['a-klasik.json', 'b-yemek-masali.json']) expect(validateLayout(load(f), cat).errors).toEqual([]);
  });

  it('A yerleşimi temiz, B bilerek konan giriş kapısı sorununu gösterir', () => {
    const a = runChecks(model, load('a-klasik.json').items.map((e) => resolveItem(e, byId)));
    expect(a.metrics.errors).toBe(0);
    const b = runChecks(model, load('b-yemek-masali.json').items.map((e) => resolveItem(e, byId)));
    expect(b.issues.some((i) => i.kind === 'swing' && i.opening === 'K-giris')).toBe(true);
  });
});
