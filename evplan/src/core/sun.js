// Güneşin gökteki yeri (NOAA'nın basitleştirilmiş formülleri; ±1° yeterli).
// Planda yön: site.northAngle = kuzeyin plan açısı (derece, +x'ten +y'ye doğru, plan saat yönünde).

import { pointInPolygon } from './geom.js';

const DEG = Math.PI / 180;

/**
 * date: yerel tarih/saat bileşenleri { y, m, d, hour } (hour ondalıklı), lat/lon derece, utcOffset saat.
 * Döner: { azimuth (kuzeyden saat yönünde, derece), elevation (ufuktan, derece) }.
 */
export function sunPosition({ y, m, d, hour }, lat, lon, utcOffset) {
  const start = Date.UTC(y, 0, 1);
  const N = Math.round((Date.UTC(y, m - 1, d) - start) / 86400000) + 1;
  const B = ((360 / 365) * (N - 81)) * DEG;
  const decl = 23.44 * Math.sin(B) * DEG;
  const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B); // dakika
  const solar = hour + (4 * (lon - 15 * utcOffset) + eot) / 60;
  const H = 15 * (solar - 12) * DEG;
  const phi = lat * DEG;
  const sinEl = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(H);
  const el = Math.asin(Math.max(-1, Math.min(1, sinEl)));
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) + Math.PI;
  return { azimuth: ((az / DEG) + 360) % 360, elevation: el / DEG };
}

/** Güneşe doğru birim vektör, plan eksenlerinde: [x, y] yatay + z yukarı. */
export function sunVector(pos, northAngle = 0) {
  const a = (northAngle + pos.azimuth) * DEG;
  const e = pos.elevation * DEG;
  return [Math.cos(e) * Math.cos(a), Math.cos(e) * Math.sin(a), Math.sin(e)];
}

/**
 * Cephe camları: aynı duvardaki camlar (pencere ve camlı kapı) tek cephe olarak birleşir.
 * Döner: [{ wall, s0, s1, z0, z1, face, sg, outward, room }] — face/sg: odanın olduğu duvar yüzü ve yönü,
 * outward: plan eksenlerinde dışarıya bakan birim normal, room: camın açıldığı oda.
 */
export function windowFacades(model) {
  const groups = new Map();
  for (const op of model.openings) {
    if (op.type !== 'window' && !op.glazed) continue;
    const g = groups.get(op.wallRef) ?? { wall: op.wallRef, s0: Infinity, s1: -Infinity, z0: Infinity, z1: -Infinity };
    g.s0 = Math.min(g.s0, op.s0);
    g.s1 = Math.max(g.s1, op.s1);
    g.z0 = Math.min(g.z0, op.sill);
    g.z1 = Math.max(g.z1, op.top);
    groups.set(op.wallRef, g);
  }
  const out = [];
  for (const g of groups.values()) {
    const w = g.wall;
    const s = (g.s0 + g.s1) / 2;
    const at = (o) => [w.from[0] + w.d[0] * s + w.n[0] * o, w.from[1] + w.d[1] * s + w.n[1] * o];
    for (const [face, sg] of [
      [w.oMin, -1],
      [w.oMax, 1],
    ]) {
      const room = model.rooms.find((r) => pointInPolygon(at(face + sg * 30), r.poly));
      if (!room) continue;
      out.push({ ...g, face, sg, at, outward: [-w.n[0] * sg, -w.n[1] * sg], room: room.name });
      break;
    }
  }
  return out;
}

/** Güneşin camına doğrudan vurduğu odalar (güneş ufkun üstünde ve cepheye dönük). */
export function sunlitRooms(facades, pos, northAngle = 0) {
  if (!pos || pos.elevation < 2) return [];
  const [x, y] = sunVector(pos, northAngle);
  return [...new Set(facades.filter((f) => f.outward[0] * x + f.outward[1] * y > 0.08).map((f) => f.room))];
}
