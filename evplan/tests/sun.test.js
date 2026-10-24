import { describe, expect, it } from 'vitest';
import { sunPosition, sunVector } from '../src/core/sun.js';
import { convertModel } from '../src/core/importModel.js';

const ANKARA = [39.93, 32.85, 3];

describe('güneş konumu', () => {
  it('Ankara, 21 Haziran: öğle yüksekliği ≈ 90 − 39,9 + 23,4 = 73,5°, güneyde', () => {
    let best = { elevation: -90 };
    for (let h = 11; h <= 15; h += 0.05) {
      const p = sunPosition({ y: 2026, m: 6, d: 21, hour: h }, ...ANKARA);
      if (p.elevation > best.elevation) best = { ...p, hour: h };
    }
    expect(best.elevation).toBeCloseTo(73.5, 0);
    expect(best.azimuth).toBeGreaterThan(170);
    expect(best.azimuth).toBeLessThan(190);
    expect(best.hour).toBeCloseTo(12.85, 0); // yerel öğle ≈ 12:50 (UTC+3, boylam 32,85°)
  });

  it('kış gündönümü öğlesi alçak, gece ufkun altında', () => {
    expect(sunPosition({ y: 2026, m: 12, d: 21, hour: 12.8 }, ...ANKARA).elevation).toBeCloseTo(26.6, 0);
    expect(sunPosition({ y: 2026, m: 12, d: 21, hour: 22 }, ...ANKARA).elevation).toBeLessThan(0);
  });

  it('plan yönü: kuzey +x iken öğle güneşi −x tarafında', () => {
    const v = sunVector({ azimuth: 180, elevation: 30 }, 0);
    expect(v[0]).toBeCloseTo(-Math.cos(Math.PI / 6));
    expect(v[1]).toBeCloseTo(0);
    expect(sunVector({ azimuth: 90, elevation: 0 }, 0)[1]).toBeCloseTo(1); // doğu = +y
  });

  it('içe aktarma konumu ve kuzeyi plan.site alanına yazar', () => {
    const m = {
      _meta: { name: 'T', location: { city: 'Ankara', lat: 39.93, lon: 32.85 }, coordinate_system: { x: '+x = kuzey', z: '+z = doğu' } },
      rooms: [{ id: 'a', name: 'A', ceiling_height: 2.7, polygon: [[0, 0], [3, 0], [3, 3], [0, 3]], openings: [] }],
    };
    expect(convertModel(m).plan.site).toEqual({ city: 'Ankara', lat: 39.93, lon: 32.85, utcOffset: 3, northAngle: 0 });
    const z = convertModel({ ...m, _meta: { ...m._meta, coordinate_system: { z: '+z = kuzey' } } }).plan.site;
    expect(z.northAngle).toBe(90);
  });
});

describe('güneş alan odalar', async () => {
  const { buildPlanModel } = await import('../src/core/plan.js');
  const { windowFacades, sunlitRooms } = await import('../src/core/sun.js');
  // 4 × 3 m oda; cam alt duvarda (planda +y yönüne, kuzey +x iken DOĞU cephesi).
  const model = buildPlanModel({
    walls: [
      { id: 'N', from: [0, 0], to: [400, 0], thickness: 10, side: 'left' },
      { id: 'E', from: [400, 0], to: [400, 300], thickness: 10, side: 'left' },
      { id: 'S', from: [400, 300], to: [0, 300], thickness: 10, side: 'left' },
      { id: 'W', from: [0, 300], to: [0, 0], thickness: 10, side: 'left' },
    ],
    openings: [{ id: 'c', type: 'window', wall: 'S', offset: 100, width: 150, sill: 90, height: 140 }],
    rooms: [{ id: 'r', name: 'Oda', polygon: [[0, 0], [400, 0], [400, 300], [0, 300]] }],
  });
  const f = windowFacades(model);

  it('cephe dışa doğru bakar ve odayı bilir', () => {
    expect(f).toHaveLength(1);
    expect(f[0].room).toBe('Oda');
    expect(f[0].outward[0]).toBeCloseTo(0);
    expect(f[0].outward[1]).toBeCloseTo(1);
  });

  it('doğu cephesi sabah güneş alır, akşam almaz', () => {
    const morning = sunPosition({ y: 2026, m: 6, d: 21, hour: 8 }, ...ANKARA);
    const evening = sunPosition({ y: 2026, m: 6, d: 21, hour: 18 }, ...ANKARA);
    expect(sunlitRooms(f, morning, 0)).toEqual(['Oda']);
    expect(sunlitRooms(f, evening, 0)).toEqual([]);
    expect(sunlitRooms(f, evening, 180)).toEqual(['Oda']); // kuzey ters olsaydı cam batıya bakardı
  });
});
