import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { frontLeaves, itemBoxes, moduleItems, resolveItem, stackItems, tvSpot } from '../src/core/items.js';
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
  it('Klem performans kadife: seçilen varyant (Bej / Açık / Kalıcı Form) ve kalibre renk', () => {
    const it0 = resolveItem({ uid: 'a', ref: 'normod-klem-3-pk', x: 0, y: 0, choice: { Kumaş: 'Bej', Ayak: 'Açık', 'Sırt Minderi': 'Kalıcı Form' } }, byId);
    expect(it0.variant.id).toBe(51863732846959);
    expect(it0.price).toBe(43530);
    expect(it0.url).toContain('performans-kadife-4?variant=51863732846959');
    expect(it0.parts).toMatchObject({ fabric: '#dad5cd', legs: '#b5814d', backStyle: 'firm' });
    expect(cat.items.filter((c) => c.group === 'Koltuklar').map((c) => c.id)).toEqual(['normod-klem-3-pk']);
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
    expect(s.spotFor(byId.get('normod-klem-3-pk'))).toBeNull(); // başka tür: bilinen yer yok
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

  it('L köşe koltuk: taban iki kanat (köşe içi boş), köşe yönü varyantı değiştirmez', () => {
    // Katalogda L koltuk kalmadı; aynı kurgu deneme ürünüyle sınanır.
    const pk = byId.get('normod-klem-3-pk');
    const Lcat = {
      ...pk,
      id: 'deneme-L',
      w: 290,
      d: 290,
      shape: { ...pk.shape, type: 'sofaL', wing: 91 },
      options: [...pk.options, { name: 'Köşe', part: 'corner', values: [{ name: 'Sol arka', value: 'left' }, { name: 'Sağ arka', value: 'right' }] }],
      variantOptions: ['Kumaş', 'Ayak', 'Sırt Minderi'],
    };
    const cat2 = new Map([...byId, ['deneme-L', Lcat]]);
    const at = (corner) => resolveItem({ uid: 'k', ref: 'deneme-L', x: 300, y: 300, rot: 0, choice: { Köşe: corner } }, cat2);
    const L = at('Sol arka');
    const [back, side] = itemBoxes(L);
    expect([back.w, back.d, back.y]).toEqual([290, 91, 300 - 145 + 45.5]);
    expect([side.w, side.d, side.x]).toEqual([91, 199, 300 - 145 + 45.5]);
    expect(itemBoxes(at('Sağ arka'))[1].x).toBe(300 + 145 - 45.5);
    expect(L.variant?.price).toBe(43530);
    // Köşe içine konan orta sehpa koltukla çakışmaz.
    const r = runChecks(buildPlanModel(room), [L, resolveItem({ uid: 's', ref: 'orta-sehpa', x: 330, y: 330, rot: 0 }, cat2)], { passage: false });
    expect(r.issues.filter((i) => i.kind === 'collision')).toEqual([]);
  });

  it('takım (masa + 6 sandalye) tek adımda eklenir, sandalyeler masaya döner', () => {
    const s = new Store({ plan: { meta: { name: 'x' } }, catalog: cat, fileLayouts: [{ id: 'l', name: 'L', items: [] }] });
    const set = byId.get('ikea-stockholm-2025-takim');
    const uids = s.addSet(set, 300, 250, 90);
    expect(uids).toHaveLength(7);
    const chairs = s.items().filter((i) => i.ref === 'ikea-stockholm-2025-sandalye');
    expect(chairs).toHaveLength(6);
    expect(new Set(chairs.map((c) => c.rot))).toEqual(new Set([90, 270]));
    s.undo();
    expect(s.items()).toHaveLength(0);
  });

  it('düz örnek halılar: standart ölçüler, renk seçeneği, örnek etiketi, çakışmaz', () => {
    const rugs = cat.items.filter((c) => c.group === 'Halılar' && c.sample);
    expect(rugs.map((c) => `${c.w}×${c.d}`)).toEqual(['80×150', '120×180', '160×230', '200×290', '200×300', '240×320', '240×340', '300×400', '80×300']);
    const r = resolveItem({ uid: 'h', ref: 'hali-240x320', x: 0, y: 0, choice: { Renk: 'Antrasit' } }, byId);
    expect(r).toMatchObject({ color: '#4b4b4e', sample: true, assumed: false, collides: false });
    expect(rugs.every((c) => c.sample && !c.brand && c.options[0].values.some((v) => v.name === 'Kum'))).toBe(true);
  });

  it('Nun Lizbon: ölçü seçeneği boyutu, renk iki tonlu dokuyu, varyant fiyat ve linki belirler', () => {
    const l = resolveItem({ uid: 'l', ref: 'nun-lizbon', x: 0, y: 0 }, byId);
    expect([l.w, l.d, l.color, l.price]).toEqual([80, 150, '#b8bbaa', 1950]);
    expect(l.url).toBe('https://nundekoratifhali.com/nun-lizbon-serisi?renk=yesil&olcu=80150');
    expect(l.parts).toMatchObject({ weaveCell: '#abae9d', weaveLine: '#c9ccbc' });
    const b = resolveItem({ uid: 'l', ref: 'nun-lizbon', x: 0, y: 0, choice: { Renk: 'Antrasit', Ölçü: '160×230' } }, byId);
    expect([b.w, b.d, b.price, b.collides]).toEqual([160, 230, 5500, false]);
    expect(b.url).toContain('renk=antrasit&olcu=160230');
  });
});
