// Kodla üretilen yüzey dokuları (dış dosya yok): meşe parke, seramik, petek dilimleri, ahşap lif.
// Her doku gerçek ölçüyle tanımlanır (cm); yüzeyde aynı ölçüde görünsün diye UV'ler metre cinsindendir.
// Parke tahtası ve derz ölçüleri görsel varsayımdır; ölçü kontrollerine girmez.

import * as THREE from 'three';

function rng(seed) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

function tex(c, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const cache = new Map();
const once = (key, fn) => {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
};

/**
 * Düz döşeme meşe parke: tahta 18 × 120 cm (varsayım), şaşırtmalı derz.
 * Döner: { map, bump, size: [uzunluk, genişlik] (cm) } — doku x'i tahta boyu.
 */
export function oakPlanks() {
  return once('oak', () => {
    const L = 120;
    const W = 18;
    const rows = 12;
    const cols = 2; // tekrar belli olmasın diye doku 240 × 216 cm'lik alanı kaplar
    const px = 6; // piksel / cm
    const [c, x] = canvas(L * cols * px, W * rows * px);
    const [b, bx] = canvas((L * cols * px) / 2, (W * rows * px) / 2);
    const r = rng(11);
    bx.fillStyle = '#fff';
    bx.fillRect(0, 0, b.width, b.height);
    const TW = L * cols * px;
    for (let row = 0; row < rows; row++) {
      const y0 = row * W * px;
      const off = r() * L * px;
      // Satırda tahtalar uç uca; doku kenarında sarar (şaşırtmalı derz).
      for (let k = -1; k < cols; k++) {
        const start = off + k * L * px;
        const tone = 0.93 + r() * 0.12;
        const warm = (r() - 0.5) * 10;
        const base = [188 * tone + warm, 154 * tone, 116 * tone - warm].map((v) => Math.max(0, Math.min(255, Math.round(v))));
        x.fillStyle = `rgb(${base})`;
        x.fillRect(start, y0, L * px, W * px);
        // Lifler: tahta boyunca ince dalgalı çizgiler; tahtanın bir kısmında "alev" deseni.
        const lines = 60 + Math.floor(r() * 30);
        for (let i = 0; i < lines; i++) {
          const yy = y0 + r() * W * px;
          const dark = r() < 0.55;
          const a = 0.04 + r() * 0.09;
          x.strokeStyle = dark ? `rgba(98,66,38,${a})` : `rgba(255,240,210,${a * 0.7})`;
          x.lineWidth = 0.5 + r() * 1.6;
          x.beginPath();
          const ph = r() * 10;
          const amp = 0.4 + r() * 2;
          const wl = 50 + r() * 60;
          for (let s = 0; s <= L * px; s += 18) x.lineTo(start + s, yy + Math.sin(s / wl + ph) * amp);
          x.stroke();
        }
        if (r() < 0.35) {
          const kx = start + (0.15 + r() * 0.7) * L * px;
          const ky = y0 + (0.25 + r() * 0.5) * W * px;
          for (let q = 4; q > 0; q--) {
            x.strokeStyle = `rgba(95,62,34,${0.06 + q * 0.03})`;
            x.lineWidth = 1;
            x.beginPath();
            x.ellipse(kx, ky, q * 4 + 3, q * 1.2 + 1, 0, 0, Math.PI * 2);
            x.stroke();
          }
        }
        // Tahta başı derzi (ince, hafif koyu).
        const jx = ((start % TW) + TW) % TW;
        x.fillStyle = 'rgba(80,52,30,0.35)';
        x.fillRect(jx - 0.5, y0, 1.2, W * px);
        bx.fillStyle = '#777';
        bx.fillRect(jx / 2 - 0.5, y0 / 2, 1, (W * px) / 2);
      }
      // Uzun kenar derzi.
      x.fillStyle = 'rgba(80,52,30,0.32)';
      x.fillRect(0, y0, c.width, 1.2);
      bx.fillStyle = '#777';
      bx.fillRect(0, y0 / 2, b.width, 1);
    }
    return { map: tex(c), bump: tex(b, false), size: [L * cols, W * rows] };
  });
}

/** Kare seramik (ör. 60 × 60 cm): 2 × 2 karo, ince derz, karolar arası hafif ton farkı. */
export function ceramicTiles(sizeCm = 60, color = '#ebe9e4', grout = '#c9c4bb', seed = 5) {
  return once(`tile|${sizeCm}|${color}|${grout}`, () => {
    const n = 2;
    const px = Math.max(3, Math.round(512 / (sizeCm * n)));
    const S = sizeCm * px;
    const [c, x] = canvas(S * n, S * n);
    const [b, bx] = canvas(S * n, S * n);
    const r = rng(seed);
    const base = new THREE.Color(color);
    bx.fillStyle = '#fff';
    bx.fillRect(0, 0, b.width, b.height);
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const col = base.clone().offsetHSL(0, 0, (r() - 0.5) * 0.025);
        x.fillStyle = `#${col.getHexString()}`;
        x.fillRect(i * S, j * S, S, S);
        // Çok hafif leke/damar.
        for (let k = 0; k < 40; k++) {
          x.fillStyle = `rgba(120,110,100,${r() * 0.025})`;
          x.beginPath();
          x.arc(i * S + r() * S, j * S + r() * S, 4 + r() * 22, 0, Math.PI * 2);
          x.fill();
        }
      }
    const g = Math.max(1.5, 0.3 * px);
    x.fillStyle = grout;
    bx.fillStyle = '#666';
    for (let k = 0; k <= n; k++) {
      x.fillRect(k * S - g / 2, 0, g, c.height);
      x.fillRect(0, k * S - g / 2, c.width, g);
      bx.fillRect(k * S - g, 0, g * 2, b.height);
      bx.fillRect(0, k * S - g, b.width, g * 2);
    }
    return { map: tex(c), bump: tex(b, false), size: [sizeCm * n, sizeCm * n] };
  });
}

/** Panel petek: dikey dilimler (~2,5 cm aralık). U ekseni petek boyu boyunca tekrar eder. */
export function radiatorFins() {
  return once('fins', () => {
    const [c, x] = canvas(32, 4);
    const grd = x.createLinearGradient(0, 0, 32, 0);
    grd.addColorStop(0, '#9a9a9a');
    grd.addColorStop(0.2, '#ffffff');
    grd.addColorStop(0.75, '#f0f0f0');
    grd.addColorStop(1, '#8c8c8c');
    x.fillStyle = grd;
    x.fillRect(0, 0, 32, 4);
    return tex(c, false);
  });
}

/** Dikey lifli ahşap (dolap kapakları için). */
export function woodGrain() {
  return once('grain', () => {
    const [c, x] = canvas(256, 256);
    x.fillStyle = '#f2f2f2';
    x.fillRect(0, 0, 256, 256);
    const r = rng(7);
    for (let i = 0; i < 90; i++) {
      const px = r() * 256;
      const v = Math.round(205 + r() * 40);
      x.strokeStyle = `rgba(${v - 30},${v - 34},${v - 40},${0.18 + r() * 0.25})`;
      x.lineWidth = 0.6 + r() * 2.4;
      x.beginPath();
      for (let y = 0; y <= 256; y += 16) x.lineTo(px + Math.sin(y / 40 + i) * 2.2, y);
      x.stroke();
    }
    return tex(c);
  });
}

/**
 * Dokuyu metre cinsinden UV'li bir yüzeye ölçekli yerleştirir.
 * size: dokunun kapladığı alan (cm) [u, v]; rotate: doku 90° döndürülsün mü (ör. parke uzun kenar boyunca).
 */
export function placed(t, size, rotate = false) {
  const c = t.clone();
  c.repeat.set(100 / size[0], 100 / size[1]);
  if (rotate) c.rotation = Math.PI / 2;
  c.needsUpdate = true;
  return c;
}
