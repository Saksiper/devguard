// Parametrik dolap / TV ünitesi modeli: katalogdaki "modules" listesinden.
// Her modül: gövde (ön yüzü iç renk), isteğe bağlı kaide, alttan üste ön yüz satırları
// (door | drawer | glass | open | sliding | slidingGlass). Yerel eksenler: x genişlik, y yukarı, +z ön; cm.
// shape.style 'tonstad': panel yapısı (üst tabla, yere inen yanlar, içe çekik kaide ve alt tabla, iki rayda
// sürgü kapak, kapağın dış ucunda gömme oval ahşap kulp) ve meşe kaplama dokusu; ölçüler IKEA ölçü çiziminden.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { rowColumns } from '../../core/items.js';
import { oakVeneer, woodGrain } from '../textures.js';

function woodMat(color, wCm, hCm) {
  const t = woodGrain().clone();
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

/** Meşe kaplama paneli malzemesi: doku gerçek ölçüde, panel başına farklı bölge; vertical → lif dikey. */
function veneer(color, wCm, hCm, seed, vertical = false) {
  const base = oakVeneer();
  const t = base.clone();
  const [tw, th] = base.userData.size;
  t.repeat.set(wCm / tw, hCm / th);
  t.offset.set((seed * 0.37) % 1, (seed * 0.61) % 1);
  if (vertical) {
    t.center.set(0.5, 0.5);
    t.rotation = Math.PI / 2;
    t.repeat.set(hCm / tw, wCm / th);
  }
  t.needsUpdate = true;
  const c = new THREE.Color(color).multiplyScalar(1 / base.userData.mean); // ortalama = ürün rengi
  return new THREE.MeshStandardMaterial({ color: c, map: t, bumpMap: t, bumpScale: 0.5, roughness: 0.58 });
}

/** Stadyum (iki ucu yarım daire) şekli: w × h, merkez (0, 0). */
function stadium(w, h) {
  const r = w / 2;
  const sh = new THREE.Shape();
  sh.moveTo(-r, -h / 2 + r);
  sh.lineTo(-r, h / 2 - r);
  sh.absarc(0, h / 2 - r, r, Math.PI, 0, true);
  sh.lineTo(r, -h / 2 + r);
  sh.absarc(0, -h / 2 + r, r, 0, Math.PI, true);
  return sh;
}

/** Gömme oval ahşap kulp: yuvarlatılmış kenarlı çerçeve + koyu (gölgeli) iç çukur. Ön yüze (z) oturur. */
function ovalPull(color, x, y, z) {
  const W = 2.8;
  const H = 10.4;
  const g = new THREE.Group();
  const ring = stadium(W, H);
  ring.holes.push(stadium(W - 1.0, H - 1.0));
  const rimGeo = new THREE.ExtrudeGeometry(ring, { depth: 0.12, bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.12, bevelSegments: 3, curveSegments: 16 });
  const rim = new THREE.Mesh(rimGeo, new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(1.06), roughness: 0.5 }));
  rim.castShadow = true;
  g.add(rim);
  const cup = new THREE.Mesh(new THREE.ShapeGeometry(stadium(W - 1.0, H - 1.0), 16), new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.55), roughness: 0.7 }));
  cup.position.z = 0.02;
  g.add(cup);
  g.position.set(x, y, z);
  return g;
}

/**
 * TONSTAD modülü (TV sehpası 178×37×55, sürgü kapaklı dolap 82×37×120…): ölçüler IKEA ölçü çiziminden
 * (yan 2,4 · üst 2,5 · kaide 9 · alt tabla şeridi 1,9 cm; kapak dış ucunda 2,8 × 10,4 cm kulp).
 */
function tonstadModule(g, S, m, cx, back, md, k, color) {
  const SIDE = 2.4;
  const TOP = 2.5;
  const FEET = 0.6;
  const PL = m.plinth ?? 9;
  const DECK = 1.9;
  const DT = 1.8; // kapak kalınlığı
  const front = back + md;
  const IW = m.w - 2 * SIDE;
  const interior = veneer(S.interior ?? '#a98763', IW, m.h, k * 7 + 5);
  const add = (mesh, x, y, z) => {
    mesh.position.set(x, y, z);
    g.add(mesh);
  };
  // Yüz başına doğru ölçek: ince kenar şeritlerinde doku gerilmesin (BoxGeometry yüz sırası: +x −x +y −y +z −z).
  // Kapak çevresindeki yarıklarda görünen gizli yüzler gölgede: koyu (HD'de yarık sürekli gölge çizgisi gibi okunur).
  const shade = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.4), roughness: 0.8 });
  const topFace = veneer(color, m.w, md, k * 7 + 1);
  const topEdge = veneer(color, m.w, TOP, k * 7 + 6);
  const topEnd = veneer(color, md, TOP, k * 7 + 8);
  add(box(m.w, TOP, md, [topEnd, topEnd, topFace, shade, topEdge, topEdge]), cx, m.h - TOP / 2, back + md / 2);
  const sideH = m.h - TOP - FEET;
  for (const sx of [-1, 1]) {
    const sm = veneer(color, md, sideH, k * 7 + 2 + sx, true);
    const edge = veneer(color, SIDE, sideH, k * 7 + 12 + sx, true);
    add(box(SIDE, sideH, md, sx > 0 ? [sm, shade, sm, sm, edge, sm] : [shade, sm, sm, sm, edge, sm]), cx + sx * (m.w / 2 - SIDE / 2), FEET + sideH / 2, back + md / 2);
  }
  add(box(IW, PL - FEET, md - 3, veneer(color, IW, PL, k * 7 + 3)), cx, FEET + (PL - FEET) / 2, back + (md - 3) / 2 + 2); // kaide: önü 1 cm içeride
  const deck = veneer(color, IW, DECK, k * 7 + 4);
  add(box(IW, DECK, md - 2.2, [deck, deck, shade, deck, deck, deck]), cx, PL + DECK / 2, back + (md - 2.2) / 2); // alt tabla: önü 2,2 cm içeride
  add(box(IW, m.h - TOP - PL, 0.8, interior), cx, PL + (m.h - TOP - PL) / 2, back + 0.4); // arkalık
  const foot = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.6 });
  for (const fx of [-1, 0, 1])
    for (const fz of [-1, 1]) {
      if (fx === 0 && m.w < 120) continue;
      add(new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, FEET, 12), foot), cx + fx * (m.w / 2 - 3), FEET / 2, back + md / 2 + fz * (md / 2 - 3));
    }
  // İki sürgü kapak: sol arka rayda, sağ ön rayda; ortada 1'er cm bindirme.
  const y0 = PL + DECK + 0.3;
  const DH = m.h - TOP - 0.3 - y0;
  const DW = IW / 2 + 1;
  const type = m.fronts?.[0]?.type ?? 'sliding';
  for (const side of [-1, 1]) {
    const dx = cx + side * (IW / 2 - DW / 2);
    const dz = side < 0 ? front - 3.2 - DT / 2 : front - 1.0 - DT / 2;
    if (type === 'slidingGlass') {
      const fw = 4.5;
      for (const [i, [bw, bh, bx, by]] of [
        [DW, fw, dx, y0 + DH - fw / 2],
        [DW, fw, dx, y0 + fw / 2],
        [fw, DH, dx - DW / 2 + fw / 2, y0 + DH / 2],
        [fw, DH, dx + DW / 2 - fw / 2, y0 + DH / 2],
      ].entries())
        add(box(bw, bh, DT, veneer(color, bw, bh, k * 7 + 11 + i + side, bh > bw)), bx, by, dz);
      const pane = new THREE.Mesh(new THREE.PlaneGeometry(DW - 2 * fw, DH - 2 * fw), new THREE.MeshPhysicalMaterial({ color: 0xeef3f2, transparent: true, opacity: 0.18, roughness: 0.05, depthWrite: false }));
      pane.renderOrder = 3;
      add(pane, dx, y0 + DH / 2, dz);
    } else {
      add(box(DW, DH, DT, veneer(color, DW, DH, k * 7 + 9 + side)), dx, y0 + DH / 2, dz);
    }
    // Kulp: kapağın dış ucunda, yan panelin iç yüzünden 2,6 cm içeride, kapak yüksekliğinin ortasında.
    const px = cx + side * (IW / 2 - 2.6);
    g.add(ovalPull(color, px, y0 + DH / 2, dz + DT / 2 + 0.01));
  }
  // Raflar (camlı kapakta görünür): sehpada her bölmede bir, dolapta iki.
  const shelves = m.h > 80 ? [1 / 3, 2 / 3] : [0.5];
  for (const f of shelves) add(box(IW - 0.4, 1.8, md - 7, interior), cx, y0 + DH * f, back + (md - 7) / 2 + 1);
}

export function buildCabinets(it) {
  const S = it.shape ?? {};
  const g = new THREE.Group();
  const modules = it.modules ?? [{ w: it.w, h: it.h, fronts: [] }];
  if (S.style === 'tonstad') {
    let tx = -it.w / 2;
    modules.forEach((m, k) => {
      tonstadModule(g, S, m, tx + m.w / 2, -it.d / 2, m.d ?? it.d, k, S.front ?? it.color);
      tx += m.w;
    });
    g.scale.setScalar(0.01);
    return g;
  }
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
