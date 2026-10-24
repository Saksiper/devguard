// 2D plan geometrisi. Tüm değerler santimetre; x sağa, y aşağı (plan görüntüsü gibi).
// Açılar derece; ekranda saat yönünde artar (y aşağı olduğu için standart formül böyle görünür).

export const DEG = Math.PI / 180;

export function rotate([x, y], deg) {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return [x * c - y * s, x * s + y * c];
}

export function add(a, b) {
  return [a[0] + b[0], a[1] + b[1]];
}

export function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1]];
}

export function scale(a, k) {
  return [a[0] * k, a[1] * k];
}

export function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1];
}

export function cross(a, b) {
  return a[0] * b[1] - a[1] * b[0];
}

export function len(a) {
  return Math.hypot(a[0], a[1]);
}

export function norm(a) {
  const l = len(a);
  return l > 0 ? [a[0] / l, a[1] / l] : [0, 0];
}

/** Yürüme yönüne göre sol normal (y aşağı ekranda "sol"). */
export function leftNormal(d) {
  return [d[1], -d[0]];
}

/** Merkez, genişlik (yerel x), derinlik (yerel y), dönüş → 4 köşe (saat yönünde). */
export function rectCorners(cx, cy, w, d, rot = 0) {
  const hw = w / 2;
  const hd = d / 2;
  return [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ].map((p) => add(rotate(p, rot), [cx, cy]));
}

/** Yerel koordinattaki noktayı plana taşır (yerel +y = mobilyanın önü). */
export function toWorld(local, cx, cy, rot) {
  return add(rotate(local, rot), [cx, cy]);
}

export function toLocal(p, cx, cy, rot) {
  return rotate(sub(p, [cx, cy]), -rot);
}

export function polygonArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

export function polygonCentroid(poly) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const f = p[0] * q[1] - q[0] * p[1];
    a += f;
    cx += (p[0] + q[0]) * f;
    cy += (p[1] + q[1]) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const n = poly.length;
    return [poly.reduce((s, p) => s + p[0], 0) / n, poly.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function bbox(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

export function pointInPolygon([x, y], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function project(poly, axis) {
  let min = Infinity;
  let max = -Infinity;
  for (const p of poly) {
    const v = dot(p, axis);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return [min, max];
}

/**
 * İki dışbükey çokgenin ayırma ekseni testi (SAT).
 * Dönüş: en küçük eksen örtüşmesi (cm). <= 0 ise değmiyor/ayrık.
 */
export function convexOverlap(a, b) {
  let minOverlap = Infinity;
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const edge = sub(q, p);
      if (len(edge) < 1e-9) continue;
      const axis = norm(leftNormal(edge));
      const [a0, a1] = project(a, axis);
      const [b0, b1] = project(b, axis);
      const o = Math.min(a1, b1) - Math.max(a0, b0);
      if (o <= 0) return o;
      if (o < minOverlap) minOverlap = o;
    }
  }
  return minOverlap;
}

/** Merkez, yarıçap, başlangıç ve bitiş açısı (derece) → dışbükey dilim çokgeni. */
export function sectorPolygon(center, radius, a0, a1, segments = 12) {
  const pts = [center];
  for (let i = 0; i <= segments; i++) {
    const a = (a0 + ((a1 - a0) * i) / segments) * DEG;
    pts.push([center[0] + Math.cos(a) * radius, center[1] + Math.sin(a) * radius]);
  }
  return pts;
}

export function angleOf(v) {
  return Math.atan2(v[1], v[0]) / DEG;
}

/** Işın (origin + t*dir) ile doğru parçası kesişimi → t (cm) ya da null. */
export function raySegment(origin, dir, p, q) {
  const e = sub(q, p);
  const den = cross(dir, e);
  if (Math.abs(den) < 1e-12) return null;
  const w = sub(p, origin);
  const t = cross(w, e) / den;
  const u = cross(w, dir) / den;
  if (t >= -1e-6 && u >= -1e-6 && u <= 1 + 1e-6) return Math.max(0, t);
  return null;
}

export function rayPolygon(origin, dir, poly) {
  let best = null;
  for (let i = 0; i < poly.length; i++) {
    const t = raySegment(origin, dir, poly[i], poly[(i + 1) % poly.length]);
    if (t !== null && (best === null || t < best)) best = t;
  }
  return best;
}

export function round(v, step = 1) {
  return Math.round(v / step) * step;
}

/** Açıyı [0, 360) aralığına getirir. */
export function normAngle(deg) {
  return ((deg % 360) + 360) % 360;
}
