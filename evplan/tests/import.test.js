import { describe, expect, it } from 'vitest';
import { convertModel } from '../src/core/importModel.js';
import { buildPlanModel } from '../src/core/plan.js';
import { runChecks } from '../src/core/checks.js';
import { validatePlan } from '../src/core/validate.js';

// Sentetik model (metre): 4 × 3 m oda, 10 cm sonra 3 × 3 m ikinci oda; koridor ölçülmemiş.
const model = {
  _meta: { name: 'Test', wall_thickness_assumed: 0.1 },
  rooms: [
    {
      id: 'a',
      name: 'A',
      ceiling_height: 2.7,
      floor: 'meşe parke',
      polygon: [[0, 0], [4, 0], [4, 3], [0, 3]],
      openings: [
        { type: 'kapı', label: 'Kapı', edge: 3, offset_from_edge_start: 1, width: 0.9, head: 2.1, hinge_at: 'start', swings: 'odanın içine' },
        { type: 'cam', label: 'Cam', edge: 1, offset_from_edge_start: 0, width: 2.4, sill: 0, head: 2.3, panels: 3, opening_panels: [1] },
      ],
      radiators: [{ label: 'Petek', edge: 0, center_offset_from_edge_start: 2, width: 0.8, height: 0.6, bottom: 0.15, wall_gap: 0.05, depth: 0.1 }],
      built_ins: [{ label: 'Dolap', material: 'cab', box: { x0: 0, x1: 0.6, y0: 0, y1: 2, z0: 2.4, z1: 3 } }],
    },
    { id: 'b', name: 'B', ceiling_height: 2.7, floor: 'seramik', polygon: [[0, 3.05], [3, 3.05], [3, 6], [0, 6]], openings: [] },
  ],
  missing: [{ name: 'Koridor / antre' }],
};

describe('model içe aktarma', () => {
  const { plan, thin } = convertModel(model);

  it('geçerli plan üretir, metreyi cm yapar', () => {
    expect(validatePlan(plan).errors).toEqual([]);
    expect(plan.rooms[0].polygon[2]).toEqual([400, 300]);
    expect(plan.rooms[1].floor).toBe('seramik');
  });

  it('duvarlar dışa doğru, komşuya taşmadan', () => {
    const w = plan.walls.find((x) => x.id === 'a-3'); // A'nın alt kenarı, B'ye 5 cm boşluk
    expect(w.thickness).toBeLessThanOrEqual(5);
    expect(thin.length).toBeGreaterThan(0);
    const m = buildPlanModel(plan);
    const wall = m.walls.find((x) => x.id === 'a-1');
    // a-1 kenarı (0,0)→(400,0); dış taraf y < 0
    const outY = wall.from[1] + wall.n[1] * (wall.oMin + wall.oMax) / 2;
    expect(outY).toBeLessThan(0);
  });

  it('kapı odaya açılır; koridor eksikse giriş sayılır', () => {
    const m = buildPlanModel(plan);
    const d = m.doors.find((x) => x.name.includes('Kapı'));
    expect(d.entrance).toBe(true);
    for (const [x] of d.leaves.flatMap((l) => [l.hinge])) expect(x).toBeGreaterThanOrEqual(-0.01);
    expect(m.entrances).toContain(d);
  });

  it('cam kanatlara bölünür: ortadaki açılan kanat kapı, yanlar sabit', () => {
    const glass = plan.openings.filter((o) => o.wall === 'a-2');
    expect(glass.map((o) => o.type)).toEqual(['window', 'door', 'window']);
    expect(glass[1]).toMatchObject({ offset: 80, width: 80, glazed: true, sill: 0 });
  });

  it('petek duvardan boşluk + yarım derinlik içeride', () => {
    const p = plan.fixtures.find((f) => f.type === 'radiator');
    expect(p).toMatchObject({ x: 200, y: 10, w: 80, d: 10, h: 60, z: 15 });
  });

  it('dönüştürülen planda kontroller çalışır (odalar ayrı, her kapıdan analiz)', () => {
    const r = runChecks(buildPlanModel(plan), []);
    expect(r.metrics.errors).toBe(0);
    expect(r.passage).not.toBeNull();
  });
});
