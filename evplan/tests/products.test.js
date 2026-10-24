import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { frontLeaves, moduleItems, resolveItem, stackItems, tvSpot } from '../src/core/items.js';
import { buildPlanModel } from '../src/core/plan.js';
import { runChecks } from '../src/core/checks.js';
import { Store } from '../src/store.js';

const cat = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../public/data/furniture.json'), 'utf8'));
const byId = new Map(cat.items.map((i) => [i.id, i]));
const room = {
  meta: { name: 't' },
  walls: [
    { id: 'N', from: [0, 0], to: [600, 0], thickness: 20, side: 'left' },
    { id: 'E', from: [600, 0], to: [600, 500], thickness: 20, side: 'left' },
    { id: 'S', from: [600, 500], to: [0, 500], thickness: 20, side: 'left' },
    { id: 'W', from: [0, 500], to: [0, 0], thickness: 20, side: 'left' },
  ],
  openings: [{ id: 'k', type: 'door', wall: 'S', offset: 250, width: 90, hinge: 'start', swing: 'right', entrance: true }],
  rooms: [{ id: 'r', name: 'Oda', polygon: [[0, 0], [600, 0], [600, 500], [0, 500]] }],
};

describe('gerçek ürünler', () => {
  it('Klem: seçenekler renge ve mağaza varyantına çevrilir', () => {
    const it0 = resolveItem({ uid: 'a', ref: 'normod-klem-3', x: 0, y: 0, choice: { Kumaş: 'Sisli Yeşil', Ayak: 'Açık', 'Sırt Minderi': 'Kalıcı Form' } }, byId);
    expect(it0.variant.id).toBe(44576718881010);
    expect(it0.price).toBe(47090);
    expect(it0.url).toContain('variant=44576718881010');
    expect(it0.parts).toMatchObject({ fabric: '#a7a895', legs: '#b5814d', backStyle: 'firm' });
  });

  it('BESTÅ modülleri ayrı kutu: TV 38 cm sehpanın üstüne oturur, çakışma yok', () => {
    const items = stackItems([
      resolveItem({ uid: 'u', ref: 'ikea-besta-300', x: 300, y: 22, rot: 0 }, byId),
      resolveItem({ uid: 't', ref: 'tv-55', x: 300, y: 20, rot: 0 }, byId),
    ]);
    expect(moduleItems(items[0]).map((m) => m.h)).toEqual([193, 38, 129]);
    expect(items[1].z).toBe(38);
    const r = runChecks(buildPlanModel(room), items, { passage: false });
    expect(r.issues.filter((i) => i.kind === 'collision')).toEqual([]);
  });

  it('LANESUND sehpası: iki cam kapak (48 cm), ortası açık; TV yeri sehpa modülü', () => {
    const u = resolveItem({ uid: 'u', ref: 'ikea-lanesund-322', x: 300, y: 24, rot: 0 }, byId);
    const leaves = frontLeaves(u);
    expect(leaves.length).toBe(4 + 2);
    expect(leaves.slice(4).map((l) => l.radius)).toEqual([48, 48]);
    expect(tvSpot(u)[0]).toBeCloseTo(80.5); // sağdaki 161 cm'lik sehpanın ortası
  });

  it('kapağın önüne konan mobilya modül kapağını engeller', () => {
    const items = [
      resolveItem({ uid: 'u', ref: 'ikea-besta-300', x: 300, y: 22, rot: 0 }, byId),
      resolveItem({ uid: 'b', ref: 'kitaplik', x: 180, y: 70, rot: 0 }, byId), // boy dolabın önüne
    ];
    const r = runChecks(buildPlanModel(room), items, { passage: false });
    expect(r.issues.some((i) => i.kind === 'front' && i.text.includes('kapak'))).toBe(true);
  });

  it('Yerine dene: arka kenar aynı hizada kalır, TV yeni sehpaya taşınır', () => {
    const s = new Store({
      plan: { meta: { name: 'x' } },
      catalog: cat,
      fileLayouts: [{ id: 'l', name: 'L', items: [
        { uid: 'u', ref: 'ikea-besta-300', x: 300, y: 22, rot: 0 },
        { uid: 't', ref: 'tv-55', x: 300, y: 20, rot: 0 },
      ] }],
    });
    s.swap('u', 'ikea-tonstad-342');
    const u = s.item('u');
    expect(u.y - u.d / 2).toBeCloseTo(22 - 42 / 2); // arka kenar 1 cm'de kaldı
    expect(s.item('t').z).toBe(55);
    s.swap('u', 'ikea-lanesund-322');
    expect(s.item('t').x).toBeCloseTo(300 + 80.5);
    expect(s.item('t').z).toBe(55);
  });

  it('silinen ünitenin yeri hatırlanır: yeni aynı türden ürün oraya (arkası hizalı) gelir', () => {
    const s = new Store({
      plan: { meta: { name: 'x' } },
      catalog: cat,
      fileLayouts: [{ id: 'l', name: 'L', items: [{ uid: 'u', ref: 'ikea-besta-300', x: 300, y: 22, rot: 0 }] }],
    });
    s.update('u', { x: 280, rot: 0 });
    s.remove('u');
    const spot = s.spotFor(byId.get('jysk-lyngvig-160'));
    expect(spot).toMatchObject({ x: 280, rot: 0, occupied: false });
    expect(spot.y - 40 / 2).toBeCloseTo(22 - 42 / 2); // arka kenar aynı
    expect(s.spotFor(byId.get('normod-klem-3'))).toBeNull(); // başka tür: bilinen yer yok
  });

  it('Samsung Q60: iki ayak ünitenin üstünde mi, ağırlık üst tablayı aşıyor mu', () => {
    const on = (unit, x = 300) =>
      runChecks(
        buildPlanModel(room),
        stackItems([
          resolveItem({ uid: 'u', ref: unit, x: 300, y: 40, rot: 0 }, byId),
          resolveItem({ uid: 't', ref: 'samsung-qe55q60d', x, y: 30, rot: 0 }, byId),
        ]),
        { passage: false },
      ).issues.filter((i) => i.kind === 'support');
    // LYNGVIG 120: ayak aralığı 89,6 cm sığar, TV üniteden 3 cm geniş → yalnız bilgi; 15,5 kg ≤ 20 kg
    expect(on('jysk-lyngvig-120').map((i) => i.severity)).toEqual(['info']);
    // Orta sehpa (100 cm) üstünde TV 20 cm sağa kayarsa sağ ayak boşta kalır
    expect(on('orta-sehpa', 320).some((i) => i.severity === 'error' && i.text.includes('boşlukta'))).toBe(true);
    expect(on('ikea-besta-300')).toEqual([]);
  });

  it('gizlenen mobilya çizilmez ve kontrollere girmez; TV düğmesi türün hepsini açıp kapar', () => {
    const s = new Store({
      plan: { meta: { name: 'x' } },
      catalog: cat,
      fileLayouts: [{ id: 'l', name: 'L', items: [
        { uid: 'u', ref: 'ikea-besta-300', x: 300, y: 22, rot: 0 },
        { uid: 't', ref: 'samsung-qe55q60d', x: 300, y: 20, rot: 0 },
      ] }],
    });
    expect(s.toggleGroupHidden('Televizyon')).toBe(true);
    expect(s.items().map((i) => i.uid)).toEqual(['u']);
    expect(s.hiddenEntries().map((i) => i.uid)).toEqual(['t']);
    expect(s.toggleGroupHidden('Televizyon')).toBe(false);
    expect(s.item('t').z).toBe(38);
    s.setHidden('t', true);
    s.undo();
    expect(s.hiddenEntries()).toEqual([]);
  });
});
