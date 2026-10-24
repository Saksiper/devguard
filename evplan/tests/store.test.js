import { describe, expect, it } from 'vitest';
import { Store, decodeShare, encodeShare } from '../src/store.js';

const plan = { meta: { name: 'test' } };
const catalog = { items: [{ id: 'kutu', name: 'Kutu', w: 100, d: 50, h: 80 }] };
const fileLayouts = [{ id: 'a', name: 'A', items: [{ uid: 'x1', ref: 'kutu', x: 10, y: 20, rot: 0 }] }];

describe('Store', () => {
  it('ekle / taşı / geri al / yinele', () => {
    const s = new Store({ plan, catalog, fileLayouts });
    const uid = s.add('kutu', 100, 100);
    expect(s.items()).toHaveLength(2);
    s.update(uid, { x: 150 });
    expect(s.item(uid).x).toBe(150);
    s.undo();
    expect(s.item(uid).x).toBe(100);
    s.redo();
    expect(s.item(uid).x).toBe(150);
    expect(s.active.modified).toBe(true);
  });

  it('sürükleme tek geri alma adımıdır', () => {
    const s = new Store({ plan, catalog, fileLayouts });
    s.beginDrag();
    for (let x = 11; x < 30; x++) s.update('x1', { x }, { live: true });
    s.endDrag();
    expect(s.item('x1').x).toBe(29);
    s.undo();
    expect(s.item('x1').x).toBe(10);
  });

  it('yerleşim kopyala, dışa/içe aktar', () => {
    const s = new Store({ plan, catalog, fileLayouts });
    const id = s.createLayout('Deneme', 'a');
    expect(s.activeId).toBe(id);
    expect(s.items()[0].x).toBe(10);
    const json = s.exportLayout(id);
    const id2 = s.importLayout(JSON.parse(json));
    expect(s.layouts.get(id2).items).toHaveLength(1);
    expect(s.deleteLayout('a')).toBe(false); // dosya kaynaklı silinmez
  });

  it('paylaşım linki çift yönlü', async () => {
    const token = await encodeShare(fileLayouts[0]);
    const back = await decodeShare(token);
    expect(back.items[0]).toEqual({ ref: 'kutu', x: 10, y: 20, rot: 0 });
  });
});
