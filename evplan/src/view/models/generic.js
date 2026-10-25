// Genel parametrik mobilya modelleri (G×D×Y ve katalogdaki "shape" parametrelerinden):
// table, chair, officeChair, bed, case (kapaklı/çekmeceli/sürgülü dolap), shelf, fridge, washer, rug.
// Yerel eksenler: x = genişlik, y = yukarı, +z = ön; geometri cm ile kurulur, en sonda 1/100 ölçeklenir.
// İç ayrıntılar (ayak kalınlığı, minder, kitaplar…) görsel varsayımdır; ölçü kontrolü dış kutuyla yapılır.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { placed, woodGrain } from '../textures.js';

const col = (c) => new THREE.Color(c);
const wood = (c, w = 70, h = 140) => new THREE.MeshStandardMaterial({ color: col(c), map: placed(woodGrain(), [w, h]), roughness: 0.55 });
const matte = (c, r = 0.7, m = 0) => new THREE.MeshStandardMaterial({ color: col(c), roughness: r, metalness: m });
const fabric = (c) => new THREE.MeshStandardMaterial({ color: col(c), roughness: 0.95 });
const METAL = () => matte('#2b2b2e', 0.35, 0.8);
const CHROME = () => matte('#c9ccd0', 0.2, 1);

function mesh(geo, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}
const box = (w, h, d, mat, x, y, z) => mesh(new THREE.BoxGeometry(w, h, d), mat, x, y, z);
const rbox = (w, h, d, r, mat, x, y, z) =>
  mesh(new RoundedBoxGeometry(w, h, d, 3, Math.max(0.1, Math.min(r, w / 2 - 0.01, h / 2 - 0.01, d / 2 - 0.01))), mat, x, y, z);
const cyl = (rt, rb, h, mat, x, y, z, seg = 20) => mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat, x, y, z);

function done(g) {
  g.scale.setScalar(0.01);
  return g;
}

/** Masa / sehpa: tabla, kayıt, dört ayak; shape.round → yuvarlak tabla; shape.shelf → alt raf. */
export function buildTable(it) {
  const S = it.shape ?? {};
  const g = new THREE.Group();
  const top = wood(it.color, 90, 60);
  const legMat = S.legColor ? wood(S.legColor) : top;
  const t = S.top ?? 3;
  const leg = S.leg ?? 5;
  const inset = S.inset ?? 4;
  if (S.round) {
    g.add(cyl(it.w / 2, it.w / 2, t, top, 0, it.h - t / 2, 0, 48));
    g.add(cyl(4, 4, it.h - t, legMat, 0, (it.h - t) / 2, 0));
    g.add(cyl(it.w * 0.22, it.w * 0.24, 2, legMat, 0, 1, 0, 36));
    return done(g);
  }
  g.add(rbox(it.w, t, it.d, 0.6, top, 0, it.h - t / 2, 0));
  const ax = it.w / 2 - inset - leg / 2;
  const az = it.d / 2 - inset - leg / 2;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(box(leg, it.h - t, leg, legMat, sx * ax, (it.h - t) / 2, sz * az));
  const ap = S.apron ?? (it.h > 60 ? 8 : 5);
  g.add(box(2 * ax - leg, ap, 2, legMat, 0, it.h - t - ap / 2, az));
  g.add(box(2 * ax - leg, ap, 2, legMat, 0, it.h - t - ap / 2, -az));
  g.add(box(2, ap, 2 * az - leg, legMat, ax, it.h - t - ap / 2, 0));
  g.add(box(2, ap, 2 * az - leg, legMat, -ax, it.h - t - ap / 2, 0));
  if (S.shelf) g.add(box(2 * ax, 2, 2 * az, top, 0, S.shelf, 0));
  return done(g);
}

/** Sandalye: oturak (minderli), arkalık, dört ayak. */
export function buildChair(it) {
  const S = it.shape ?? {};
  const g = new THREE.Group();
  const frame = wood(it.color, 40, 90);
  const seatMat = fabric(S.seat ?? '#cfc6b8');
  const sh = it.dims?.seatHeight ?? 46;
  const leg = 3.6;
  const sd = it.d * 0.86;
  const zf = it.d / 2 - sd / 2;
  const ax = it.w / 2 - leg / 2 - 1;
  g.add(box(it.w - 2, 3, sd, frame, 0, sh - 4.5, zf));
  g.add(rbox(it.w - 5, 4, sd - 4, 1.5, seatMat, 0, sh - 1, zf + 0.5));
  const zb = zf - sd / 2 + leg / 2;
  for (const sx of [-1, 1]) {
    g.add(box(leg, sh - 3, leg, frame, sx * ax, (sh - 3) / 2, zf + sd / 2 - leg / 2 - 1));
    const post = box(leg, it.h, leg, frame, sx * ax, it.h / 2, zb);
    post.rotation.x = -0.06;
    g.add(post);
  }
  const back = rbox(it.w - 2, Math.min(28, it.h - sh - 14), 2.4, 1, frame, 0, it.h - 16, zb - 1.6);
  back.rotation.x = -0.08;
  g.add(back);
  return done(g);
}

/** Çalışma sandalyesi: beş kollu ayak, tekerlek, gaz piston, oturak, arkalık, kolçak. */
export function buildOfficeChair(it) {
  const S = it.shape ?? {};
  const g = new THREE.Group();
  const shell = fabric(it.color);
  const metal = METAL();
  const r = Math.min(it.w, it.d) / 2 - 3;
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2;
    const arm = box(r, 2.4, 4, metal, (Math.cos(a) * r) / 2, 7, (Math.sin(a) * r) / 2);
    arm.rotation.y = -a;
    g.add(arm);
    g.add(mesh(new THREE.SphereGeometry(2.6, 12, 8), metal, Math.cos(a) * r, 2.6, Math.sin(a) * r));
  }
  const sh = it.dims?.seatHeight ?? 47;
  g.add(cyl(2.4, 2.4, sh - 14, CHROME(), 0, 6 + (sh - 14) / 2, 0));
  g.add(rbox(it.w * 0.82, 8, it.d * 0.78, 3, shell, 0, sh - 2, 2));
  const backH = it.h - sh - 8;
  const back = rbox(it.w * 0.76, backH, 6, 3, shell, 0, sh + 6 + backH / 2, -it.d / 2 + 8);
  back.rotation.x = -0.1;
  g.add(back);
  g.add(box(4, 22, 4, metal, 0, sh + 4, -it.d / 2 + 10));
  if (S.arms !== false)
    for (const sx of [-1, 1]) {
      g.add(box(3, 18, 3, metal, sx * (it.w * 0.41 + 1), sh + 7, 0));
      g.add(rbox(6, 3, 24, 1.2, matte('#1f1f22', 0.8), sx * (it.w * 0.41 + 1), sh + 17, 0));
    }
  return done(g);
}

/** Yatak: baza/çerçeve, şilte, nevresim (kenarlardan sarkar), yastıklar, döşemeli başlık. */
export function buildBed(it) {
  const S = it.shape ?? {};
  const g = new THREE.Group();
  const frame = S.wood ? wood(it.color) : fabric(it.color);
  const headT = S.headboard ?? 8;
  const legH = S.legHeight ?? 8;
  const baseH = S.baseHeight ?? 25;
  const mattH = S.mattress ?? 22;
  const z0 = -it.d / 2;
  g.add(rbox(it.w, baseH, it.d - headT, 1.5, frame, 0, legH + baseH / 2, (headT) / 2));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(box(5, legH, 5, METAL(), sx * (it.w / 2 - 6), legH / 2, sz * (it.d / 2 - 8)));
  const top = legH + baseH;
  const mw = it.w - 4;
  const md = it.d - headT - 3;
  const mz = z0 + headT + 1 + md / 2;
  g.add(rbox(mw, mattH, md, 4, fabric('#f4f2ee'), 0, top + mattH / 2, mz));
  // Nevresim: şiltenin ayak tarafındaki ~%72'sini örter, yanlardan biraz sarkar.
  const dl = md * 0.72;
  const duvet = fabric(S.duvet ?? '#e7e1d6');
  g.add(rbox(mw + 3, 9, dl, 4, duvet, 0, top + mattH + 2, mz + md / 2 - dl / 2 + 1));
  g.add(rbox(mw + 3.4, mattH * 0.7, dl, 2, duvet, 0, top + mattH * 0.55, mz + md / 2 - dl / 2 + 1.2));
  const n = it.w >= 140 ? 2 : 1;
  const pw = Math.min(70, (mw - 10) / n);
  for (let i = 0; i < n; i++) {
    const px = n === 1 ? 0 : (i - 0.5) * (pw + 6);
    const p = rbox(pw, 13, 40, 6, fabric('#fbfaf7'), px, top + mattH + 6, z0 + headT + 24);
    p.rotation.x = -0.25;
    g.add(p);
  }
  g.add(rbox(it.w, it.h - legH, headT, 3, frame, 0, legH + (it.h - legH) / 2, z0 + headT / 2));
  return done(g);
}

/**
 * Dolap gövdesi + ön yüz. shape.fronts: 'doors' (count), 'drawers' (rows × cols), 'sliding' (count), 'open'.
 * shape.plinth: kaide yüksekliği; shape.legs: ayak yüksekliği (kaide yerine).
 */
export function buildCase(it) {
  const S = it.shape ?? {};
  const g = new THREE.Group();
  const body = S.wood ? wood(it.color) : matte(it.color, 0.55);
  const front = S.wood ? wood(S.front ?? it.color, 60, 120) : matte(S.front ?? it.color, 0.45);
  const handle = matte(S.handle ?? '#3a3a3c', 0.35, 0.7);
  const legs = S.legs ?? 0;
  const plinth = legs ? 0 : (S.plinth ?? 6);
  const y0 = legs || plinth;
  const H = it.h - y0;
  g.add(box(it.w, H, it.d - 2, body, 0, y0 + H / 2, -1));
  if (plinth) g.add(box(it.w - 4, plinth, it.d - 6, matte('#2f2f31', 0.8), 0, plinth / 2, -1));
  if (legs) for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(cyl(1.6, 1.2, legs, METAL(), sx * (it.w / 2 - 4), legs / 2, sz * (it.d / 2 - 5)));
  const zf = it.d / 2 - 1;
  const gap = 0.45;
  const kind = S.fronts ?? (it.drawers && !it.frontDoors ? 'drawers' : 'doors');
  // Kapak aralıkları koyu görünsün: ön yüzlerin hemen arkasında koyu bir panel.
  if (kind !== 'open') g.add(box(it.w - 0.4, H - 0.4, 0.2, matte('#262626', 0.9), 0, y0 + H / 2, zf - 1));
  if (kind === 'sliding') {
    const n = S.count ?? 2;
    const pw = it.w / n + 2;
    for (let i = 0; i < n; i++) {
      const x = -it.w / 2 + pw / 2 + i * ((it.w - pw) / Math.max(1, n - 1));
      g.add(box(pw, H - 1, 1.8, front, x, y0 + H / 2, zf - (i % 2) * 2.2));
      g.add(box(1.2, 40, 1.2, handle, x + (i % 2 ? -1 : 1) * (pw / 2 - 4), y0 + H * 0.5, zf + 1 - (i % 2) * 2.2));
    }
    return done(g);
  }
  if (kind === 'drawers') {
    const rows = S.rows ?? Math.max(1, Math.round(H / 22));
    const cols = S.cols ?? 1;
    const dh = H / rows;
    const dw = it.w / cols;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const x = -it.w / 2 + dw * (c + 0.5);
        const y = y0 + dh * (r + 0.5);
        g.add(box(dw - gap, dh - gap, 1.8, front, x, y, zf));
        g.add(box(Math.min(16, dw * 0.4), 1.2, 1.6, handle, x, y + dh * 0.25, zf + 1.6));
      }
    return done(g);
  }
  if (kind === 'open') return done(g);
  const n = S.count ?? it.frontDoors?.count ?? Math.max(1, Math.round(it.w / 50));
  const dw = it.w / n;
  for (let i = 0; i < n; i++) {
    const x = -it.w / 2 + dw * (i + 0.5);
    g.add(box(dw - gap, H - gap, 1.8, front, x, y0 + H / 2, zf));
    const right = n === 1 ? (it.frontDoors?.hinge ?? 'left') === 'left' : i % 2 === 0;
    const hx = x + (right ? 1 : -1) * (dw / 2 - 3.5);
    const hy = H > 120 ? Math.min(y0 + H - 10, 105) : y0 + H - 8;
    g.add(box(1.2, H > 120 ? 28 : 10, 1.6, handle, hx, hy - (H > 120 ? 0 : 5), zf + 1.6));
  }
  return done(g);
}

/** Kitaplık: yanlar, raflar, arkalık; raflarda rastgele (tohumlu) kitaplar. */
export function buildShelf(it) {
  const S = it.shape ?? {};
  const g = new THREE.Group();
  const m = S.wood === false ? matte(it.color, 0.5) : wood(it.color);
  const t = 1.8;
  for (const sx of [-1, 1]) g.add(box(t, it.h, it.d, m, sx * (it.w / 2 - t / 2), it.h / 2, 0));
  g.add(box(it.w, t, it.d, m, 0, it.h - t / 2, 0));
  g.add(box(it.w - 2 * t, 6, it.d - 2, m, 0, 3, -1));
  g.add(box(it.w - 2 * t, it.h - 6, 0.6, matte(it.color, 0.8), 0, it.h / 2 + 3, -it.d / 2 + 0.3));
  const n = S.shelves ?? Math.max(1, Math.round((it.h - 10) / 36));
  const step = (it.h - 6 - t) / n;
  let seed = [...String(it.ref ?? it.id ?? 'k')].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const BOOK = ['#7f1d1d', '#1e3a8a', '#365314', '#78350f', '#e7e5e4', '#44403c', '#9a3412', '#0f766e', '#d6d3d1', '#1f2937'];
  for (let k = 0; k < n; k++) {
    const y = 6 + k * step;
    if (k > 0) g.add(box(it.w - 2 * t, t, it.d - 1.5, m, 0, y + t / 2, 0.5));
    if (S.books === false) continue;
    let x = -it.w / 2 + t + 1;
    const end = it.w / 2 - t - 1 - (rnd() < 0.5 ? it.w * 0.25 : 0);
    while (x < end) {
      const bw = 1.8 + rnd() * 3.2;
      const bh = Math.min(step - 4, 18 + rnd() * 10);
      const bd = Math.min(it.d - 6, 15 + rnd() * 6);
      if (x + bw > end) break;
      g.add(box(bw, bh, bd, matte(BOOK[Math.floor(rnd() * BOOK.length)], 0.75), x + bw / 2, y + t + bh / 2, -it.d / 2 + 2 + bd / 2));
      x += bw + 0.15;
    }
  }
  return done(g);
}

/** Buzdolabı: alt dondurucu (ayrı kapak), dikey kulplar. */
export function buildFridge(it) {
  const S = it.shape ?? {};
  const g = new THREE.Group();
  const shell = matte(it.color, 0.3, S.steel ? 0.85 : 0.15);
  g.add(rbox(it.w, it.h - 2, it.d - 4, 2, shell, 0, it.h / 2 + 1, -2));
  const fh = S.freezer ?? Math.round(it.h * 0.36);
  const zf = it.d / 2 - 2;
  const hingeLeft = (it.frontDoors?.hinge ?? 'right') === 'left';
  const hx = (hingeLeft ? 1 : -1) * (it.w / 2 - 5);
  for (const [y0, y1] of [
    [2, fh],
    [fh + 0.6, it.h - 1],
  ]) {
    g.add(rbox(it.w - 0.6, y1 - y0, 3.6, 1.5, shell, 0, (y0 + y1) / 2, zf));
    const hl = Math.min(40, (y1 - y0) * 0.5);
    g.add(box(2, hl, 2.4, CHROME(), hx, y0 === 2 ? y1 - 6 - hl / 2 : y0 + 8 + hl / 2, zf + 3));
  }
  return done(g);
}

/** Çamaşır makinesi: gövde, kontrol şeridi, yuvarlak kapak (cam + krom çerçeve). */
export function buildWasher(it) {
  const g = new THREE.Group();
  const shell = matte(it.color, 0.35, 0.05);
  g.add(rbox(it.w, it.h - 1, it.d - 1, 1.5, shell, 0, it.h / 2, -0.5));
  const zf = it.d / 2;
  g.add(box(it.w - 2, 0.3, 0.5, matte('#cfcfd2', 0.6), 0, it.h - 13, zf));
  g.add(cyl(2.8, 2.8, 2, CHROME(), it.w * 0.28, it.h - 6.5, zf, 24).rotateX(Math.PI / 2));
  g.add(box(it.w * 0.34, 4, 0.6, matte('#1b1b1d', 0.3), -it.w * 0.12, it.h - 6.5, zf + 0.3));
  const r = Math.min(it.w * 0.3, 17);
  const cy = it.h * 0.48;
  const ring = mesh(new THREE.TorusGeometry(r, 2.6, 16, 48), CHROME(), 0, cy, zf + 1.5);
  g.add(ring);
  const glass = new THREE.MeshPhysicalMaterial({ color: '#2a3440', roughness: 0.05, metalness: 0.1, clearcoat: 1, transparent: true, opacity: 0.85 });
  g.add(mesh(new THREE.CircleGeometry(r - 1.5, 40), glass, 0, cy, zf + 1.2));
  return done(g);
}

let rugTexture = null;
function rugTex() {
  if (rugTexture) return rugTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const x = c.getContext('2d');
  const img = x.createImageData(256, 256);
  let s = 3;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 256 * 256; i++) {
    const v = 225 + rnd() * 30 - ((i % 2) ^ ((i >> 8) % 2)) * 8;
    img.data.set([v, v, v, 255], i * 4);
  }
  x.putImageData(img, 0, 0);
  rugTexture = new THREE.CanvasTexture(c);
  rugTexture.wrapS = rugTexture.wrapT = THREE.RepeatWrapping;
  rugTexture.colorSpace = THREE.SRGBColorSpace;
  return rugTexture;
}

/** Halı: dokuma görünümlü yüzey, koyu kenar bordürü; shape.plain → bordürsüz tek renk. */
export function buildRug(it) {
  const S = it.shape ?? {};
  const g = new THREE.Group();
  const t = rugTex().clone();
  t.repeat.set(it.w / 25, it.d / 25);
  t.needsUpdate = true;
  const h = Math.max(0.6, it.h);
  const field = new THREE.MeshStandardMaterial({ color: col(it.color), map: t, roughness: 1 });
  const border = new THREE.MeshStandardMaterial({ color: col(S.border ?? it.color).multiplyScalar(0.7), map: t, roughness: 1 });
  if (S.plain) {
    // Düz halı: tek renk, kenarı hafif yuvarlatılmış.
    const rug = rbox(it.w, h, it.d, Math.min(0.8, h / 2), field, 0, h / 2, 0);
    rug.castShadow = false;
    g.add(rug);
    return done(g);
  }
  const b = S.borderWidth ?? 12;
  const base = box(it.w, h, it.d, border, 0, h / 2, 0);
  base.castShadow = false;
  g.add(base);
  const inner = box(it.w - 2 * b, 0.1, it.d - 2 * b, field, 0, h + 0.05, 0);
  inner.castShadow = false;
  g.add(inner);
  return done(g);
}

/** Dönen berjer: siyah yuvarlak döner taban, yuvarlatılmış gövde, kolçaklar, minder, hafif yatık sırt. */
export function buildSwivel(it) {
  const S = it.shape ?? {};
  const g = new THREE.Group();
  const f = fabric(it.color);
  const black = matte(S.base ?? '#1c1c1e', 0.4, 0.6);
  const W = it.w;
  const D = it.d;
  const A = S.armWidth ?? 15;
  g.add(cyl(29, 30, 2, black, 0, 1, 0, 40));
  g.add(cyl(3.5, 4.5, 19, black, 0, 11.5, 0));
  g.add(rbox(W, 3, D, 1.2, f, 0, 22.5, 0));
  for (const sx of [-1, 1]) g.add(rbox(A, 38, D, 3, f, sx * (W / 2 - A / 2), 43, 0));
  g.add(rbox(W - 2 * A, 19, D - 2, 2, f, 0, 33.5, 1));
  g.add(rbox(W - 2 * A - 1, 7, D - 22.5, 4, f, 0, 46.5, -D / 2 + 22 + (D - 22.5) / 2));
  const back = rbox(W - 2 * A + 4, it.h - 24, 22, 5, f, 0, 24 + (it.h - 24) / 2, -D / 2 + 11);
  back.rotation.x = -0.09;
  g.add(back);
  return done(g);
}

/** Tek şaseli (iki uçta panel ayaklı) yemek masası: tabla, ayak panelleri, taban ve üst kayıt. */
export function buildTrestle(it) {
  const g = new THREE.Group();
  const m = wood(it.color, 120, 60);
  const t = 3.5;
  const inset = it.shape?.inset ?? 42;
  g.add(rbox(it.w, t, it.d, 0.8, m, 0, it.h - t / 2, 0));
  for (const sx of [-1, 1]) {
    const x = sx * (it.w / 2 - inset);
    g.add(rbox(6, it.h - t - 3, it.d - 28, 0.5, m, x, 3 + (it.h - t - 3) / 2, 0));
    g.add(rbox(8, 3, it.d - 20, 0.6, m, x, 1.5, 0));
  }
  g.add(rbox(it.w - 2 * inset, 6, 5, 0.4, m, 0, 12, 0));
  g.add(box(it.w - 2 * inset, 5.5, 4, m, 0, it.h - t - 2.75, 0));
  return done(g);
}

/** Yuvarlak oturaklı ahşap sandalye: dört ayak, deri minder, oturağı arkadan saran kavisli sırt. */
export function buildBentwood(it) {
  const S = it.shape ?? {};
  const g = new THREE.Group();
  const m = wood(it.color, 40, 60);
  const leather = new THREE.MeshStandardMaterial({ color: col(S.seat ?? '#6b4a33'), roughness: 0.5 });
  const r = Math.min(it.w, it.d) / 2 - 3;
  const sh = it.dims?.seatHeight ?? 45;
  const lx = it.w / 2 - 13;
  const lz = it.d / 2 - 11;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(cyl(1.5, 1.8, sh - 4, m, sx * lx, (sh - 4) / 2, sz * lz, 14));
  g.add(cyl(r, r, 3, m, 0, sh - 2.5, 0, 40));
  g.add(cyl(r + 1, r + 1, 4.5, leather, 0, sh + 1.25, 0, 40));
  // Sırt: oturağın arka yarısını saran halka dilimi; yanlarda ve arkada ince dikmeler.
  const R = r + 3.5;
  const shape = new THREE.Shape();
  const a0 = Math.PI * 0.92;
  const a1 = Math.PI * 2.08;
  shape.absarc(0, 0, R, a0, a1, false);
  shape.absarc(0, 0, R - 1.6, a1, a0, true);
  const band = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 12, bevelEnabled: false, curveSegments: 32 }), m);
  band.rotation.x = Math.PI / 2; // şekil (x, y) → dünya (x, z); kalınlık aşağı (sin < 0 tarafı = arka)
  band.position.y = it.h;
  band.castShadow = band.receiveShadow = true;
  g.add(band);
  for (const a of [Math.PI, Math.PI * 1.25, Math.PI * 1.5, Math.PI * 1.75, Math.PI * 2]) {
    const x = Math.cos(a) * (R - 0.8);
    const z = Math.sin(a) * (R - 0.8); // band ile aynı yön: şekil y'si dünyada +z
    g.add(cyl(1.1, 1.1, it.h - 12 - sh, m, x, sh + (it.h - 12 - sh) / 2, z, 10));
  }
  return done(g);
}
