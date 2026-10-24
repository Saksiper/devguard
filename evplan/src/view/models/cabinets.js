// Parametrik dolap / TV ünitesi modeli: katalogdaki "modules" listesinden.
// Her modül: gövde (ön yüzü iç renk), isteğe bağlı kaide, alttan üste ön yüz satırları
// (door | drawer | glass | open | sliding | slidingGlass). Yerel eksenler: x genişlik, y yukarı, +z ön; cm.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { rowColumns } from '../../core/items.js';

let grainTexture = null;
function grainTex() {
  if (grainTexture) return grainTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = '#f2f2f2';
  x.fillRect(0, 0, 256, 256);
  // Dikey lifler: rastgele ama tekrarlanabilir (sabit tohum).
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 90; i++) {
    const px = rnd() * 256;
    const wdt = 0.6 + rnd() * 2.4;
    const v = Math.round(205 + rnd() * 40);
    x.strokeStyle = `rgba(${v - 30},${v - 34},${v - 40},${0.18 + rnd() * 0.25})`;
    x.lineWidth = wdt;
    x.beginPath();
    for (let y = 0; y <= 256; y += 16) x.lineTo(px + Math.sin(y / 40 + i) * 2.2, y);
    x.stroke();
  }
  grainTexture = new THREE.CanvasTexture(c);
  grainTexture.wrapS = grainTexture.wrapT = THREE.RepeatWrapping;
  grainTexture.colorSpace = THREE.SRGBColorSpace;
  return grainTexture;
}

function woodMat(color, wCm, hCm) {
  const t = grainTex().clone();
  t.repeat.set(Math.max(0.3, wCm / 70), Math.max(0.3, hCm / 140));
  t.needsUpdate = true;
  return new THREE.MeshStandardMaterial({ color: new THREE.Color(color), map: t, roughness: 0.62 });
}

let caneTexture = null;
function caneMat(color, wCm, hCm) {
  if (!caneTexture) {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const x = c.getContext('2d');
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, 32, 32);
    x.fillStyle = '#2a2018';
    for (const [cx, cy] of [
      [8, 8],
      [24, 24],
    ]) {
      x.beginPath();
      x.arc(cx, cy, 4.2, 0, Math.PI * 2);
      x.fill();
    }
    caneTexture = new THREE.CanvasTexture(c);
    caneTexture.wrapS = caneTexture.wrapT = THREE.RepeatWrapping;
    caneTexture.colorSpace = THREE.SRGBColorSpace;
  }
  const t = caneTexture.clone();
  t.repeat.set(wCm / 2.4, hCm / 2.4); // hasır gözü ~1,2 cm
  t.needsUpdate = true;
  return new THREE.MeshStandardMaterial({ color: new THREE.Color(color), map: t, roughness: 0.8 });
}

const box = (w, h, d, mat) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
};

export function buildCabinets(it) {
  const S = it.shape ?? {};
  const g = new THREE.Group();
  const modules = it.modules ?? [{ w: it.w, h: it.h, fronts: [] }];
  const back = -it.d / 2;
  const interior = new THREE.MeshStandardMaterial({ color: new THREE.Color(S.interior ?? '#8a7a6a'), roughness: 0.8 });
  const plinthMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(S.plinth ?? S.carcass ?? it.color), roughness: 0.7 });
  const frameMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(S.frame ?? S.front ?? it.color), roughness: 0.5, metalness: S.frame === '#202020' ? 0.3 : 0 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0xe3edf2, transparent: true, opacity: 0.22, roughness: 0.08, depthWrite: false });
  const handleMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(S.handle ?? '#1f1f1f'), roughness: 0.4, metalness: 0.5 });
  const FT = 1.8; // ön panel kalınlığı
  let x = -it.w / 2;

  // Mobilya geneli ayaklar (shape.legs): konik yuvarlak (4 köşe) ya da blok (2 adet, içe çekik).
  const L = S.legs ?? null;
  if (L) {
    if (L.type === 'block') {
      const geo = new RoundedBoxGeometry(L.w ?? 10, L.h, L.depth ?? it.d * 0.7, 3, Math.min(L.radius ?? 4, (L.w ?? 10) / 2 - 0.1));
      for (const sx of [-1, 1]) {
        const leg = new THREE.Mesh(geo, plinthMat);
        leg.position.set(sx * (it.w / 2 - (L.inset?.[0] ?? it.w * 0.25)), L.h / 2, 0);
        leg.castShadow = true;
        g.add(leg);
      }
    } else {
      const r = (L.d ?? 4) / 2;
      const geo = new THREE.CylinderGeometry(r, L.taper ? r * 0.6 : r - 0.3, L.h, 16);
      const [ix, iz] = L.inset ?? [8, 5];
      for (const sx of [-1, 1])
        for (const sz of [-1, 1]) {
          const leg = new THREE.Mesh(geo, plinthMat);
          leg.position.set(sx * (it.w / 2 - ix), L.h / 2, sz * (it.d / 2 - iz));
          leg.castShadow = true;
          g.add(leg);
        }
    }
  }
  // Tek parça gövde (shape.singleBody): modüller yalnızca ön yüzü tanımlar; köşeler yuvarlatılabilir (shape.radius).
  if (S.singleBody) {
    const base = L?.h ?? 0;
    const bodyH = it.h - base;
    const carcD = it.d - FT;
    const side = woodMat(S.carcass ?? it.color, carcD, bodyH);
    const geo = S.radius ? new RoundedBoxGeometry(it.w, bodyH, carcD, 4, Math.min(S.radius, bodyH / 2 - 0.1, carcD / 2 - 0.1)) : new THREE.BoxGeometry(it.w, bodyH, carcD);
    const body = new THREE.Mesh(geo, [side, side, side, side, interior, side]);
    body.castShadow = body.receiveShadow = true;
    body.position.set(0, base + bodyH / 2, back + carcD / 2);
    g.add(body);
  }

  for (const m of modules) {
    const md = m.d ?? it.d;
    const cx = x + m.w / 2;
    x += m.w;
    const legs = m.legs ?? null;
    const plinth = legs ? legs.h : (m.plinth ?? L?.h ?? 0);
    const carcD = md - FT;
    const bodyH = m.h - plinth;
    const side = woodMat(S.carcass ?? it.color, carcD, bodyH);
    if (!S.singleBody) {
      const carcass = box(m.w - 0.2, bodyH, carcD, [side, side, side, side, interior, side]);
      carcass.position.set(cx, plinth + bodyH / 2, back + carcD / 2);
      g.add(carcass);
    }
    if (legs) {
      const geo = new THREE.CylinderGeometry((legs.d ?? 4) / 2, (legs.d ?? 4) / 2 - 0.3, legs.h, 16);
      const [ix, iz] = legs.inset ?? [8, 5];
      for (const sx of [-1, 1])
        for (const sz of [-1, 1]) {
          const leg = new THREE.Mesh(geo, plinthMat);
          leg.position.set(cx + sx * (m.w / 2 - ix), legs.h / 2, back + md / 2 + sz * (md / 2 - iz));
          leg.castShadow = true;
          g.add(leg);
        }
    } else if (plinth > 0 && !L) {
      const p = box(m.w - 1.2, plinth, carcD - 3, plinthMat);
      p.position.set(cx, plinth / 2, back + carcD / 2 - 1);
      g.add(p);
    }
    const front = back + carcD; // gövdenin ön yüzü
    let y = plinth + 1.6;
    for (const row of m.fronts ?? []) {
      for (const c of rowColumns(m.w, row)) {
        const cw = c.x1 - c.x0;
        const px = cx + (c.x0 + c.x1) / 2;
        const py = y + row.h / 2;
        const ph = row.h - 0.4;
        const pw = cw - 0.4;
        if (c.type === 'open') {
          // İç yüz zaten görünür; yüksek açık bölmede bir raf.
          if (ph > 25) {
            const sh = box(pw - 1, 1.6, 6, side);
            sh.position.set(px, py, front - 2.5);
            g.add(sh);
          }
          continue;
        }
        if (c.type === 'door' || c.type === 'drawer' || c.type === 'sliding') {
          const panel = box(pw, ph, FT, woodMat(S.front ?? it.color, pw, ph));
          const zOff = c.type === 'sliding' ? (c.x0 > -m.w / 2 + 1 ? -0.6 : 0.4) : 0;
          panel.position.set(px, py, front + FT / 2 + zOff);
          g.add(panel);
          if (c.type === 'drawer' && S.handle) {
            const h = box(Math.min(12, pw * 0.4), 1, 1.5, handleMat);
            h.position.set(px, py + ph / 2 - 4, front + FT + 0.75);
            g.add(h);
          }
        } else if (c.type === 'cane') {
          // Hasır (polirattan) kapak: ahşap çerçeve + hasır dokulu panel.
          const fw = 3.5;
          const z = front + FT / 2;
          const fm = woodMat(S.front ?? it.color, pw, ph);
          for (const [bw, bh, bx, by] of [
            [pw, fw, px, py + ph / 2 - fw / 2],
            [pw, fw, px, py - ph / 2 + fw / 2],
            [fw, ph, px - pw / 2 + fw / 2, py],
            [fw, ph, px + pw / 2 - fw / 2, py],
          ]) {
            const b = box(bw, bh, FT, fm);
            b.position.set(bx, by, z);
            g.add(b);
          }
          const pane = new THREE.Mesh(new THREE.PlaneGeometry(pw - 2 * fw, ph - 2 * fw), caneMat(S.cane ?? '#c39868', pw - 2 * fw, ph - 2 * fw));
          pane.position.set(px, py, z);
          g.add(pane);
          if (S.knob) {
            const k = new THREE.Mesh(new THREE.SphereGeometry(1.1, 12, 8), new THREE.MeshStandardMaterial({ color: new THREE.Color(S.knob), roughness: 0.5 }));
            k.position.set(c.hinge === 'left' ? px + pw / 2 - fw - 1.5 : px - pw / 2 + fw + 1.5, py, front + FT + 0.9);
            g.add(k);
          }
        } else if (c.type === 'glass' || c.type === 'slidingGlass') {
          const fw = S.frameWidth ?? (S.frame === '#202020' ? 1.4 : 4);
          const z = front + FT / 2;
          const bars = [
            [pw, fw, px, py + ph / 2 - fw / 2],
            [pw, fw, px, py - ph / 2 + fw / 2],
            [fw, ph, px - pw / 2 + fw / 2, py],
            [fw, ph, px + pw / 2 - fw / 2, py],
          ];
          for (const [bw, bh, bx, by] of bars) {
            const b = box(bw, bh, FT, frameMat);
            b.position.set(bx, by, z);
            g.add(b);
          }
          const pane = new THREE.Mesh(new THREE.PlaneGeometry(pw - 2 * fw, ph - 2 * fw), glass);
          pane.position.set(px, py, z + 0.2);
          pane.renderOrder = 3;
          g.add(pane);
          // Camın arkasında raf(lar): her ~35 cm'de bir.
          const shelves = Math.max(0, Math.round(ph / 35) - 1);
          for (let k = 1; k <= shelves; k++) {
            const sh = box(pw - 2 * fw, 1.6, 2, side);
            sh.position.set(px, y + (row.h * k) / (shelves + 1), front + 0.6);
            g.add(sh);
          }
          if (S.handle) {
            const hx = c.hinge === 'left' ? px + pw / 2 - fw - 2 : px - pw / 2 + fw + 2;
            const h = box(1.2, Math.min(14, ph * 0.3), 1.5, handleMat);
            h.position.set(hx, py, front + FT + 0.75);
            g.add(h);
          }
        }
      }
      y += row.h;
    }
  }
  g.scale.setScalar(0.01);
  return g;
}
