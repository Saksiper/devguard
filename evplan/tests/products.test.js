import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { frontLeaves, itemBoxes, moduleItems, resolveItem, stackItems, tvSpot } from '../src/core/items.js';
import { buildPlanModel } from '../src/core/plan.js';
import { runChecks } from '../src/core/checks.js';
import { Store } from '../src/store.js';

const realCat = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../public/data/furniture.json'), 'utf8'));
// Menteşeli kapaklı modüller için sentetik ünite (eski BESTÅ 300 verisi; katalogdan kaldırıldı ama kural testi kalsın).
const UNIT3 = {
  id: 'test-unite-3', name: 'Test ünitesi 300', group: 'TV üniteleri', w: 300, d: 42, h: 193, maxTopLoad: 50,
  modules: [
    { w: 60, h: 193, fronts: [{ type: 'door', h: 64, hinge: 'left' }, { type: 'glass', h: 64, hinge: 'left' }, { type: 'glass', h: 64, hinge: 'left' }] },
    { w: 180, h: 38, fronts: [{ type: 'drawer', h: 26, count: 3, depth: 33 }, { type: 'open', h: 11, count: 3 }] },
    { w: 60, h: 129, fronts: [{ type: 'door', h: 64, hinge: 'right' }, { type: 'glass', h: 64, hinge: 'right' }] },
  ],
};
const cat = { ...realCat, items: [...realCat.items, UNIT3] };
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

  it('TONSTAD modülleri ayrı kutu: TV 55 cm sehpanın üstüne oturur, çakışma yok; sürgü kapak kanat açmaz', () => {
    const items = stackItems([
      resolveItem({ uid: 'u', ref: 'ikea-tonstad-342', x: 300, y: 22, rot: 0 }, byId),
      resolveItem({ uid: 't', ref: 'tv-55', x: 300, y: 20, rot: 0 }, byId),
    ]);
    expect(moduleItems(items[0]).map((m) => m.h)).toEqual([119.9, 55, 119.9]);
    expect(items[1].z).toBe(55);
    expect(frontLeaves(items[0])).toEqual([]);
    expect(tvSpot(items[0])[0]).toBeCloseTo(-0.1); // ortadaki 178 cm'lik sehpanın ortası
    const r = runChecks(buildPlanModel(room), items, { passage: false });
    expect(r.issues.filter((i) => i.kind === 'collision')).toEqual([]);
  });

  it('TV üniteleri: yalnızca TONSTAD ve modülleri; alınan sehpa "alındı"', () => {
    expect(realCat.items.filter((c) => c.group === 'TV üniteleri').map((c) => c.id)).toEqual(['ikea-tonstad-342', 'ikea-tonstad-sehpa-178', 'ikea-tonstad-cam-82', 'ikea-tonstad-surgu-82']);
    const t = resolveItem({ uid: 's', ref: 'ikea-tonstad-sehpa-178', x: 0, y: 0, locked: true }, byId);
    expect([t.owned, t.locked, t.modules[0].fronts]).toEqual([true, true, [{ type: 'sliding', h: 40.9, count: 2 }]]);
  });

  it('kapağın önüne konan mobilya modül kapağını engeller', () => {
    const items = [
      resolveItem({ uid: 'u', ref: 'test-unite-3', x: 300, y: 22, rot: 0 }, byId),
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
        { uid: 'u', ref: 'test-unite-3', x: 300, y: 22, rot: 0 },
        { uid: 't', ref: 'tv-55', x: 300, y: 20, rot: 0 },
      ] }],
    });
    s.swap('u', 'ikea-tonstad-342');
    const u = s.item('u');
    expect(u.y - u.d / 2).toBeCloseTo(22 - 42 / 2); // arka kenar 1 cm'de kaldı
    expect(s.item('t').z).toBe(55);
    s.swap('u', 'ikea-tonstad-sehpa-178');
    expect(s.item('t').x).toBeCloseTo(300);
    expect(s.item('t').z).toBe(54.9);
  });

  it('silinen ünitenin yeri hatırlanır: yeni aynı türden ürün oraya (arkası hizalı) gelir', () => {
    const s = new Store({
      plan: { meta: { name: 'x' } },
      catalog: cat,
      fileLayouts: [{ id: 'l', name: 'L', items: [{ uid: 'u', ref: 'test-unite-3', x: 300, y: 22, rot: 0 }] }],
    });
    s.update('u', { x: 280, rot: 0 });
    s.remove('u');
    const spot = s.spotFor(byId.get('ikea-tonstad-sehpa-178'));
    expect(spot).toMatchObject({ x: 280, rot: 0, occupied: false });
    expect(spot.y - 37.2 / 2).toBeCloseTo(22 - 42 / 2); // arka kenar aynı
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
    // Orta sehpa (100 cm): ayak aralığı 89,6 cm sığar ama TV sehpadan geniş → yalnız bilgi
    expect(on('orta-sehpa').map((i) => i.severity)).toEqual(['info']);
    // TV 20 cm sağa kayarsa sağ ayak boşta kalır
    expect(on('orta-sehpa', 320).some((i) => i.severity === 'error' && i.text.includes('boşlukta'))).toBe(true);
    expect(on('ikea-tonstad-sehpa-178')).toEqual([]); // 15,5 kg ≤ 30 kg
    // Üst tabla yükü: 50 kg'lık ünitede sorun yok, 10 kg sınırlı üstte hata
    expect(runChecks(buildPlanModel(room), stackItems([
      resolveItem({ uid: 'u', ref: 'ikea-tonstad-sehpa-178', x: 300, y: 40, rot: 0, }, new Map([...byId, ['ikea-tonstad-sehpa-178', { ...byId.get('ikea-tonstad-sehpa-178'), maxTopLoad: 10 }]])),
      resolveItem({ uid: 't', ref: 'samsung-qe55q60d', x: 300, y: 30, rot: 0 }, byId),
    ]), { passage: false }).issues.some((i) => i.kind === 'support' && i.severity === 'error')).toBe(true);
  });

  it('gizlenen mobilya çizilmez ve kontrollere girmez; TV düğmesi türün hepsini açıp kapar', () => {
    const s = new Store({
      plan: { meta: { name: 'x' } },
      catalog: cat,
      fileLayouts: [{ id: 'l', name: 'L', items: [
        { uid: 'u', ref: 'ikea-tonstad-sehpa-178', x: 300, y: 22, rot: 0 },
        { uid: 't', ref: 'samsung-qe55q60d', x: 300, y: 20, rot: 0 },
      ] }],
    });
    expect(s.toggleGroupHidden('Televizyon')).toBe(true);
    expect(s.items().map((i) => i.uid)).toEqual(['u']);
    expect(s.hiddenEntries().map((i) => i.uid)).toEqual(['t']);
    expect(s.toggleGroupHidden('Televizyon')).toBe(false);
    expect(s.item('t').z).toBe(54.9);
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
    expect(l.parts).toMatchObject({ weaveCell: '#959884', weaveLine: '#e3e4d8' });
    const b = resolveItem({ uid: 'l', ref: 'nun-lizbon', x: 0, y: 0, choice: { Renk: 'Antrasit', Ölçü: '160×230' } }, byId);
    expect([b.w, b.d, b.price, b.collides]).toEqual([160, 230, 5500, false]);
    expect(b.url).toContain('renk=antrasit&olcu=160230');
  });

  it('IKEA STOCKHOLM 2025: iki ölçü, her ölçünün kendi desen ızgarası, fiyat ve linki', () => {
    const s = resolveItem({ uid: 's', ref: 'ikea-stockholm-2025-hali', x: 0, y: 0 }, byId);
    expect([s.w, s.d, s.price, s.collides, s.flatpack]).toEqual([240, 350, 32999, false, true]);
    expect(s.url).toMatch(/240x350-cm-el-dokumasi-hali-70593814$/);
    const k = resolveItem({ uid: 's', ref: 'ikea-stockholm-2025-hali', x: 0, y: 0, choice: { Ölçü: '170×240' } }, byId);
    expect([k.w, k.d, k.price]).toEqual([170, 240, 16999]);
    expect(k.url).toMatch(/170x240-cm-el-dokumasi-hali-40593815$/);
    // Izgara tutarlı: sınırlar 0'dan halı ölçüsüne artan, her satırda sütun sayısı kadar harf, harfler paletten.
    const pal = byId.get('ikea-stockholm-2025-hali').shape.palette;
    for (const it of [s, k]) {
      const xs = it.parts.pattern.xs.split(' ').map(Number);
      const ys = it.parts.pattern.ys.split(' ').map(Number);
      expect([xs[0], xs.at(-1), ys[0], ys.at(-1)]).toEqual([0, it.w, 0, it.d]);
      expect(xs.every((v, i) => i === 0 || v > xs[i - 1]) && ys.every((v, i) => i === 0 || v > ys[i - 1])).toBe(true);
      expect(it.parts.pattern.rows).toHaveLength(ys.length - 1);
      for (const r of it.parts.pattern.rows) expect([r.length, [...r].every((ch) => ch in pal)]).toEqual([xs.length - 1, true]);
    }
    // Büyük ölçüde blok sayısı artar (desen ölçeklenmez): 170×240'ta 5, 240×350'de 7 blok sütunu.
    const blocks = (it) => it.parts.pattern.rows[4].replace(/[^p]+/g, ' ').trim().split(' ').length;
    expect([blocks(k), blocks(s)]).toEqual([5, 7]);
  });

  it('sabit (kilitli) mobilya taşınmaz, döndürülmez, silinmez, değiştirilmez; kilidi açılınca serbest', () => {
    const s = new Store({
      plan: { meta: { name: 'x' } },
      catalog: cat,
      fileLayouts: [{ id: 'l', name: 'L', items: [{ uid: 'u', ref: 'ikea-tonstad-sehpa-178', x: 300, y: 22, rot: 0, locked: true }] }],
    });
    const warned = [];
    s.addEventListener('change', (e) => e.detail.type === 'locked' && warned.push(e.detail.uid));
    s.update('u', { x: 350, rot: 90 });
    s.swap('u', 'ikea-tonstad-342');
    s.remove('u');
    expect([s.item('u').x, s.item('u').rot, s.item('u').ref, warned.length]).toEqual([300, 0, 'ikea-tonstad-sehpa-178', 3]);
    s.update('u', { name: 'Bizim sehpa' }); // ad değişebilir
    expect(s.item('u').name).toBe('Bizim sehpa');
    const copy = s.duplicate('u');
    expect(s.item(copy).locked).toBe(false); // kopya deneme için serbest
    s.update('u', { locked: null });
    s.update('u', { x: 350 });
    expect(s.item('u').x).toBe(350);
  });

  it('Montis halılar: linkteki ölçü varsayılan, ölçüye göre fiyat ve link, desen haritası dosyası var', () => {
    const e = resolveItem({ uid: 'e', ref: 'montis-etiam-907011', x: 0, y: 0 }, byId);
    expect([e.w, e.d, e.h, e.price, e.collides]).toEqual([200, 290, 0.5, 14616, false]);
    expect(e.url).toMatch(/elp4166\?olculer=200x290$/);
    const h = resolveItem({ uid: 'h', ref: 'montis-hiprepa-333008', x: 0, y: 0, choice: { Ölçü: '80×300' } }, byId);
    expect([h.w, h.d, h.price]).toEqual([80, 300, 4649.4]);
    expect(h.url).toMatch(/333008-multi-dokuma-taban-modern-hali\?olcu=80x300$/);
    for (const id of ['montis-etiam-907011', 'montis-hiprepa-333005', 'montis-hiprepa-333008']) {
      const png = fs.readFileSync(path.resolve(__dirname, '../public/data', byId.get(id).shape.map));
      expect([png.toString('latin1', 1, 4), png.readUInt32BE(16)]).toEqual(['PNG', 240]); // ~1 cm/piksel
      expect(Object.keys(byId.get(id).variants)).toEqual(byId.get(id).options[0].values.map((v) => v.name));
    }
  });

  it('Ficus lyrata: boy seçeneği boyu, taç ve saksıyı belirler; tükenmiş boy da seçilebilir', () => {
    const f = resolveItem({ uid: 'f', ref: 'ccf-ficus-lyrata', x: 0, y: 0 }, byId);
    expect([f.h, f.w, f.price]).toEqual([175, 85, 9390]);
    expect(f.url).toMatch(/\?bitki-boyutu=170-180-cm$/);
    const [potBox, canopy] = itemBoxes(f);
    expect([potBox.w, potBox.h, canopy.z, canopy.h, canopy.soft]).toEqual([32, 30, 92, 83, true]);
    const k = resolveItem({ uid: 'f', ref: 'ccf-ficus-lyrata', x: 0, y: 0, choice: { Boy: '130–140 cm' } }, byId);
    const [kp, kc] = itemBoxes(k);
    expect([k.h, k.w, k.price, kp.w, kc.z]).toEqual([135, 60, 4500, 24, 70]);
  });

  it('bitkiler: linkteki varyant, ayak boyu, saksı sert / yaprak tacı yumuşak', () => {
    const z = resolveItem({ uid: 'z', ref: 'silis-zeytin-175', x: 120, y: 120 }, byId);
    expect([z.variant.id, z.price, z.h, z.parts.pot]).toEqual([50536930410671, 9100, 175, '#636847']);
    const za = resolveItem({ uid: 'z', ref: 'silis-zeytin-175', x: 0, y: 0, choice: { Ayak: 'Siyah ayak (30 cm)' } }, byId);
    expect([za.h, za.price]).toEqual([205, 10200]);
    const [potBox, canopy] = itemBoxes(za);
    expect([potBox.w, potBox.h, canopy.z, canopy.soft]).toEqual([25, 55, 100, true]);
    const m = resolveItem({ uid: 'm', ref: 'silis-muz-185', x: 0, y: 0 }, byId);
    expect([m.variant.id, m.price]).toEqual([47525739069615, 10190]);
    // Duvar dibindeki ağaç: tacı duvara ve yandaki koltuğa taşar ama hata yok; saksı içeride.
    const sofa = resolveItem({ uid: 's', ref: 'normod-klem-3-pk', x: 300, y: 50, rot: 0 }, byId);
    const tree = resolveItem({ uid: 't', ref: 'silis-zeytin-175', x: 168, y: 20 }, byId);
    const r = runChecks(buildPlanModel(room), [sofa, tree], { passage: false });
    expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });
});
