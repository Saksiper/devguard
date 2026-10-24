// Geçiş yolu analizi: zemin ızgarası + öklid mesafe dönüşümü + "en geniş yol" araması.
//
// Her serbest hücre için en yakın engele uzaklık hesaplanır (Felzenszwalb–Huttenlocher EDT).
// Bir noktadan diğerine giden yolun genişliği = yol boyunca en dar yerdeki 2 × uzaklık.
// Girişten her hedefe (kapılar, mobilya önleri) en geniş yol bulunur; en dar noktası raporlanır.
// Kapı kasaları "yapısal" sayılır: kapı boşluğunun iki yanındaki hücrelerde sabit duvarlar
// genişliği sınırlamaz (kapı genişliğini değiştiremezsiniz), mobilyalar yine sınırlar.

import { pointInPolygon } from './geom.js';
import { bandPolygon } from './plan.js';

const INF = 1e20;

function dt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/** sites[i] = 1 olan hücrelere kare uzaklık (hücre biriminde). */
export function edt(sites, W, H) {
  const out = new Float64Array(W * H);
  const n = Math.max(W, H);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = sites[y * W + x] ? 0 : INF;
    dt1d(f, H, d, v, z);
    for (let y = 0; y < H; y++) out[y * W + x] = d[y];
  }
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) f[x] = out[row + x];
    dt1d(f, W, d, v, z);
    for (let x = 0; x < W; x++) out[row + x] = d[x];
  }
  return out;
}

class Grid {
  constructor(bounds, step) {
    this.step = step;
    this.x0 = bounds.minX - 2 * step;
    this.y0 = bounds.minY - 2 * step;
    this.W = Math.ceil((bounds.maxX - bounds.minX) / step) + 4;
    this.H = Math.ceil((bounds.maxY - bounds.minY) / step) + 4;
    this.N = this.W * this.H;
  }
  center(i) {
    const x = i % this.W;
    const y = (i - x) / this.W;
    return [this.x0 + (x + 0.5) * this.step, this.y0 + (y + 0.5) * this.step];
  }
  index([px, py]) {
    const x = Math.floor((px - this.x0) / this.step);
    const y = Math.floor((py - this.y0) / this.step);
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return -1;
    return y * this.W + x;
  }
  /** Çokgenin içine merkezi düşen hücreleri işaretler. */
  fill(poly, arr, value = 1) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of poly) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    const s = this.step;
    const gx0 = Math.max(0, Math.floor((minX - this.x0) / s));
    const gy0 = Math.max(0, Math.floor((minY - this.y0) / s));
    const gx1 = Math.min(this.W - 1, Math.ceil((maxX - this.x0) / s));
    const gy1 = Math.min(this.H - 1, Math.ceil((maxY - this.y0) / s));
    const pt = [0, 0];
    for (let gy = gy0; gy <= gy1; gy++) {
      pt[1] = this.y0 + (gy + 0.5) * s;
      for (let gx = gx0; gx <= gx1; gx++) {
        pt[0] = this.x0 + (gx + 0.5) * s;
        if (pointInPolygon(pt, poly)) arr[gy * this.W + gx] = value;
      }
    }
  }
}

/** En geniş yol (maximin) — kova kuyruğu ile, 1 cm çözünürlük. Birden çok kaynak hücre olabilir. */
function widestPaths(grid, clear, sources) {
  const { N, W } = grid;
  const label = new Float32Array(N).fill(-1);
  const prev = new Int32Array(N).fill(-1);
  let maxC = 0;
  for (let i = 0; i < N; i++) if (clear[i] > maxC) maxC = clear[i];
  const buckets = Array.from({ length: Math.ceil(maxC) + 2 }, () => []);
  for (const s of sources) {
    if (clear[s] <= 0) continue;
    label[s] = clear[s];
    buckets[Math.floor(clear[s])].push(s);
  }
  const nbr = [-1, 1, -W, W, -W - 1, -W + 1, W - 1, W + 1];
  for (let b = buckets.length - 1; b >= 0; b--) {
    const bucket = buckets[b];
    while (bucket.length) {
      const i = bucket.pop();
      const li = label[i];
      const x = i % W;
      for (let k = 0; k < 8; k++) {
        const j = i + nbr[k];
        if (j < 0 || j >= N) continue;
        if (Math.abs((j % W) - x) > 1) continue;
        const cj = clear[j];
        if (cj <= 0) continue;
        const nl = cj < li ? cj : li;
        if (nl > label[j]) {
          label[j] = nl;
          prev[j] = i;
          buckets[Math.floor(nl)].push(j);
        }
      }
    }
  }
  return { label, prev };
}

/** Çokgen içindeki (ya da çok küçükse merkezine en yakın) hücreler. */
function regionCells(grid, poly) {
  const mark = new Uint8Array(grid.N);
  grid.fill(poly, mark);
  const out = [];
  for (let i = 0; i < grid.N; i++) if (mark[i]) out.push(i);
  if (!out.length) {
    const c = poly.reduce((a, p) => [a[0] + p[0] / poly.length, a[1] + p[1] / poly.length], [0, 0]);
    const i = grid.index(c);
    if (i >= 0) out.push(i);
  }
  return out;
}

/**
 * Genişliği en az minClear olan hücrelerden geçen en kısa yol (Dial algoritması;
 * düz adım 2, çapraz adım 3 birim). En geniş yollar arasından kısa olanı seçmek için.
 */
function shortestWithin(grid, clear, minClear, sources) {
  const { N, W } = grid;
  const dist = new Int32Array(N).fill(-1);
  const prev = new Int32Array(N).fill(-1);
  const ring = [[], [], [], []];
  for (const s of sources) {
    if (clear[s] < minClear) continue;
    dist[s] = 0;
    ring[0].push(s);
  }
  const nbr = [-1, 1, -W, W, -W - 1, -W + 1, W - 1, W + 1];
  const cost = [2, 2, 2, 2, 3, 3, 3, 3];
  let d = 0;
  let pending = ring[0].length;
  while (pending > 0) {
    const bucket = ring[d % 4];
    while (bucket.length) {
      const i = bucket.pop();
      pending--;
      if (dist[i] !== d) continue;
      const x = i % W;
      for (let k = 0; k < 8; k++) {
        const j = i + nbr[k];
        if (j < 0 || j >= N || Math.abs((j % W) - x) > 1 || clear[j] < minClear) continue;
        const nd = d + cost[k];
        if (dist[j] < 0 || nd < dist[j]) {
          dist[j] = nd;
          prev[j] = i;
          ring[nd % 4].push(j);
          pending++;
        }
      }
    }
    d++;
  }
  return { dist, prev };
}

function bestCell(cells, label) {
  let best = -1;
  for (const i of cells) if (label[i] > 0 && (best < 0 || label[i] > label[best])) best = i;
  return best;
}

/**
 * @param model  buildPlanModel çıktısı
 * @param obstacles { fixed: [{poly}], items: [{poly}] } — yürüme yüksekliğine giren engeller
 * @param targets [{ id, label, region (çokgen), threshold, kind }]
 */
export function analyzePassage(model, obstacles, targets) {
  const step = model.settings.gridStep;
  const source = model.entrance;
  if (!source || !model.rooms.length) return null;

  const pts = [...model.rooms.flatMap((r) => r.poly), ...model.doors.flatMap((d) => d.portal)];
  const bounds = {
    minX: Math.min(...pts.map((p) => p[0])),
    minY: Math.min(...pts.map((p) => p[1])),
    maxX: Math.max(...pts.map((p) => p[0])),
    maxY: Math.max(...pts.map((p) => p[1])),
  };
  const grid = new Grid(bounds, step);
  const { N } = grid;

  const free = new Uint8Array(N);
  const roomIdx = new Int16Array(N).fill(-1);
  model.rooms.forEach((r, k) => {
    const mark = new Uint8Array(N);
    grid.fill(r.poly, mark);
    for (let i = 0; i < N; i++)
      if (mark[i]) {
        free[i] = 1;
        roomIdx[i] = k;
      }
  });
  for (const d of model.doors) grid.fill(d.portal, free);

  const fixedSites = new Uint8Array(N);
  for (const o of obstacles.fixed) grid.fill(o.poly, fixedSites);
  for (let i = 0; i < N; i++) if (!free[i]) fixedSites[i] = 1;
  // Kapı boşluğunun kendisi duvar parçası değil; ama ızgara kenarında duvar hücresi kalmış olabilir.
  for (const d of model.doors) grid.fill(d.portal, fixedSites, 0);

  const itemSites = new Uint8Array(N);
  for (const o of obstacles.items) grid.fill(o.poly, itemSites);

  const dFixed = edt(fixedSites, grid.W, grid.H);
  const dItems = edt(itemSites, grid.W, grid.H);

  // Kapı çevresi muafiyeti: kapı boşluğu ± (hedef genişliğin yarısı) bandında sabit engel yok sayılır.
  const exempt = new Uint8Array(N);
  const ext = model.settings.passageMin / 2;
  for (const d of model.doors) {
    const w = d.wallRef;
    grid.fill(bandPolygon(w, d.s0, d.s1, w.oMin - ext, w.oMax + ext), exempt);
  }

  const half = step / 2;
  const cap = 400; // muaf hücrelerdeki "sonsuz" değer (kovaları şişirmesin)
  const clearWith = new Float32Array(N);
  const clearBase = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (fixedSites[i]) continue;
    const cf = exempt[i] ? cap : Math.min(cap, Math.sqrt(dFixed[i]) * step - half);
    clearBase[i] = Math.max(0, cf);
    if (itemSites[i]) continue;
    clearWith[i] = Math.max(0, Math.min(cf, Math.sqrt(dItems[i]) * step - half));
  }

  const srcCells = regionCells(grid, source.portal);
  const runWith = widestPaths(grid, clearWith, srcCells);
  const runBase = widestPaths(grid, clearBase, srcCells);

  // 1) Her hedef için ulaşılabilen en büyük genişlik (maximin).
  const pre = targets.map((t) => {
    const cells = regionCells(grid, t.region);
    const ti = bestCell(cells, runWith.label);
    const tb = bestCell(cells, runBase.label);
    return { t, cells, L: ti >= 0 ? runWith.label[ti] : 0, base: tb >= 0 ? 2 * runBase.label[tb] : null };
  });
  // 2) Aynı genişlik düzeyindeki hedefler için tek seferde "o genişlikte en kısa yol".
  const levels = new Map();
  for (const p of pre) {
    if (p.L <= 0) continue;
    const key = Math.floor(p.L * 4) / 4;
    if (!levels.has(key)) levels.set(key, shortestWithin(grid, clearWith, key - 0.01, srcCells));
    p.sp = levels.get(key);
  }
  const results = pre.map(({ t, cells, L, base, sp }) => {
    if (!sp) return { ...t, reachable: false, width: 0, baseWidth: base, path: [], bottleneck: null };
    let ti = -1;
    for (const i of cells) if (sp.dist[i] >= 0 && (ti < 0 || sp.dist[i] < sp.dist[ti])) ti = i;
    const path = [];
    let minC = Infinity;
    let minI = ti;
    for (let i = ti, guard = 0; i >= 0 && guard < N; i = sp.prev[i], guard++) {
      path.push(i);
      if (clearWith[i] < minC) {
        minC = clearWith[i];
        minI = i;
      }
    }
    const simplified = [];
    for (let k = 0; k < path.length; k += 4) simplified.push(grid.center(path[k]));
    simplified.push(grid.center(path[path.length - 1]));
    return {
      ...t,
      reachable: true,
      width: 2 * L,
      baseWidth: base,
      bottleneck: grid.center(minI),
      path: simplified,
      length: ((sp.dist[ti] / 2) * step) | 0,
    };
  });

  // Oda bazında boş zemin oranı.
  const roomFree = model.rooms.map((r) => ({ id: r.id, name: r.name, cells: 0, freeCells: 0 }));
  for (let i = 0; i < N; i++) {
    const k = roomIdx[i];
    if (k < 0) continue;
    roomFree[k].cells++;
    if (!itemSites[i] && !fixedSites[i]) roomFree[k].freeCells++;
  }

  return { step, results, roomFree, grid: { x0: grid.x0, y0: grid.y0, W: grid.W, H: grid.H } };
}
