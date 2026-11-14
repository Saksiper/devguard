// Dresuarlar (konsollar). Yerel eksenler: x genişlik, y yukarı, +z ön; cm, en sonda 1/100 ölçeklenir.
// shape.style: 'ovalGlass' (Dekopratik Asos: oval temperli cam tabla ve alt raf, kare profil metal gövde),
// 'glassSides' (NEOstill Venedik: iki masif ahşap raf, yan ayaklar temperli cam), 'bony' (Oobje Bony: bükme
// boru yan çerçeveler, uçları kalkık tepsi, alt kısımda kıvrık sac kutu; isteğe bağlı tekerlek).
// Dış ölçüler üreticiden; profil, sac kalınlığı ve kıvrım yarıçapları fotoğraftan tahmini (görsel).

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { placed, woodGrain } from '../textures.js';

const col = (c) => new THREE.Color(c);
const metal = (c, r = 0.42) => new THREE.MeshStandardMaterial({ color: col(c), roughness: r, metalness: 0.55 });
const powder = (c) => new THREE.MeshStandardMaterial({ color: col(c), roughness: 0.55, metalness: 0.15 }); // fırın boya
const glassMat = () =>
  new THREE.MeshPhysicalMaterial({ color: 0xdfece6, roughness: 0.04, transmission: 0.85, thickness: 0.4, transparent: true, opacity: 0.32, depthWrite: false });
const glassEdge = () => new THREE.MeshStandardMaterial({ color: 0x9fc4b4, roughness: 0.1, transparent: true, opacity: 0.75 });

function mesh(geo, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  return m;
}
const box = (w, h, d, mat, x, y, z) => mesh(new THREE.BoxGeometry(w, h, d), mat, x, y, z);
const rbox = (w, h, d, r, mat, x, y, z) => mesh(new RoundedBoxGeometry(w, h, d, 3, Math.max(0.05, Math.min(r, w / 2 - 0.01, h / 2 - 0.01, d / 2 - 0.01))), mat, x, y, z);

/** Oval (iki ucu yarım daire) şekil: en × derinlik, merkez (0, 0); plan düzleminde (x, z). */
function stadiumShape(w, d) {
  const r = d / 2;
  const s = new THREE.Shape();
  s.moveTo(-w / 2 + r, -r);
  s.lineTo(w / 2 - r, -r);
  s.absarc(w / 2 - r, 0, r, -Math.PI / 2, Math.PI / 2, false);
  s.lineTo(-w / 2 + r, r);
  s.absarc(-w / 2 + r, 0, r, Math.PI / 2, (Math.PI * 3) / 2, false);
  return s;
}

/** Yatay levha (cam): oval şekil, kalınlık t, üst yüzü y'de. */
function stadiumSlab(w, d, t, mat, y) {
  const geo = new THREE.ExtrudeGeometry(stadiumShape(w, d), { depth: t, bevelEnabled: false, curveSegments: 24 });
  geo.rotateX(Math.PI / 2); // şekil x–z düzlemine, kalınlık aşağı
  return mesh(geo, mat, 0, y, 0);
}

/** Oval kare profil halka (çerçeve): profilin dış çizgisi en × derinlik, kesit p × p; üst yüzü y'de. */
function stadiumRing(w, d, p, mat, y) {
  const outer = stadiumShape(w, d);
  outer.holes.push(stadiumShape(w - 2 * p, d - 2 * p));
  const geo = new THREE.ExtrudeGeometry(outer, { depth: p, bevelEnabled: false, curveSegments: 24 });
  geo.rotateX(Math.PI / 2);
  return mesh(geo, mat, 0, y, 0);
}

/** Dekopratik Asos: oval temperli cam üst tabla ve alt raf (yerden 13 cm), 15 × 15 mm kare profil, 4 ayak. */
function buildOvalGlass(g, it, S) {
  const W = it.w;
  const D = it.d;
  const H = it.h;
  const P = S.profile ?? 1.5;
  const T = S.glass ?? 0.4;
  const frame = metal(it.parts?.frame ?? S.frame ?? '#87a07f', it.parts?.frameRough ?? 0.4);
  const low = S.lowShelf ?? 13;
  // Halkalar (cam bunların üstüne oturur) ve camlar
  g.add(stadiumRing(W - 1, D - 1, P, frame, H - T));
  g.add(stadiumRing(W - 1, D - 1, P, frame, low));
  const gl = glassMat();
  for (const y of [H, low + T]) {
    const slab = stadiumSlab(W, D, T, gl, y);
    slab.renderOrder = 3;
    slab.castShadow = false;
    g.add(slab);
  }
  // Ayaklar: düz kenarın oval uçla birleştiği yerlerde (4 adet), kare profil.
  const lx = W / 2 - D / 2;
  const lz = D / 2 - 0.5 - P / 2;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(box(P, H - T, P, frame, sx * lx, (H - T) / 2, sz * lz));
}

/** NEOstill Venedik: iki masif ahşap raf (üst ve yerden 38 cm), iki yan temperli cam ayak, bağlantı pulları. */
function buildGlassSides(g, it, S) {
  const W = it.w;
  const D = it.d;
  const H = it.h;
  const T = S.shelfT ?? 3.6;
  const GT = S.glass ?? 1;
  const wood = new THREE.MeshStandardMaterial({ color: col(it.color), map: placed(woodGrain(), [70, 140], true), roughness: 0.55 });
  const gl = glassMat();
  const edge = glassEdge();
  for (const sx of [-1, 1]) {
    const pane = box(GT, H, D, gl, sx * (W / 2 - GT / 2), H / 2, 0);
    pane.castShadow = false;
    pane.renderOrder = 3;
    g.add(pane);
    // Cam kenarı (yeşilimsi) önde ve üstte ince şerit gibi görünür.
    g.add(box(GT, H, 0.15, edge, sx * (W / 2 - GT / 2), H / 2, D / 2 - 0.08));
  }
  const shelves = S.shelves ?? [H, 38];
  const steel = metal('#c9ccd0', 0.3);
  for (const top of shelves) {
    g.add(rbox(W - 2 * GT, T, D, 0.4, wood, 0, top - T / 2, 0));
    // Raf–cam bağlantı pulları (iki yanda ikişer).
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(mesh(new THREE.CylinderGeometry(1.1, 1.1, 0.5, 16).rotateZ(Math.PI / 2), steel, sx * (W / 2 + 0.2), top - T / 2, sz * (D / 2 - 5)));
  }
}

/** Kesiti yuvarlak boru, verilen noktalardan (köşeler yay ile yumuşatılır). */
function tubePath(points, r, mat, bend = 5) {
  const path = new THREE.CurvePath();
  const P = points.map((p) => new THREE.Vector3(...p));
  let start = P[0];
  for (let i = 1; i < P.length - 1; i++) {
    const a = P[i - 1];
    const b = P[i];
    const c = P[i + 1];
    const d1 = new THREE.Vector3().subVectors(a, b).normalize();
    const d2 = new THREE.Vector3().subVectors(c, b).normalize();
    const k = Math.min(bend, a.distanceTo(b) / 2, c.distanceTo(b) / 2);
    const p1 = b.clone().addScaledVector(d1, k);
    const p2 = b.clone().addScaledVector(d2, k);
    path.add(new THREE.LineCurve3(start, p1));
    path.add(new THREE.QuadraticBezierCurve3(p1, b, p2));
    start = p2;
  }
  path.add(new THREE.LineCurve3(start, P.at(-1)));
  return mesh(new THREE.TubeGeometry(path, 64, r, 10, false), mat);
}

/** Yan profili verilen kıvrık sac (x boyunca uzanır): profil noktaları (z, y), köşeler yuvarlatılmış. */
function bentSheet(width, profile, t, mat, bend = 6) {
  const s = new THREE.Shape();
  // Profilin bir yüzü boyunca git, öbür yüzden (t kalınlıkla) geri dön: basit ofset, normal yönü yaklaşık.
  const pts = [];
  const P = profile.map(([z, y]) => new THREE.Vector2(z, y));
  pts.push(P[0]);
  for (let i = 1; i < P.length - 1; i++) {
    const a = P[i - 1];
    const b = P[i];
    const c = P[i + 1];
    const k = Math.min(bend, a.distanceTo(b) / 2, c.distanceTo(b) / 2);
    const p1 = b.clone().add(a.clone().sub(b).normalize().multiplyScalar(k));
    const p2 = b.clone().add(c.clone().sub(b).normalize().multiplyScalar(k));
    for (let j = 0; j <= 6; j++) {
      const u = j / 6;
      const q = p1.clone().multiplyScalar((1 - u) ** 2).add(b.clone().multiplyScalar(2 * u * (1 - u))).add(p2.clone().multiplyScalar(u * u));
      pts.push(q);
    }
  }
  pts.push(P.at(-1));
  const off = pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const tan = b.clone().sub(a).normalize();
    return p.clone().add(new THREE.Vector2(-tan.y, tan.x).multiplyScalar(t));
  });
  s.moveTo(pts[0].x, pts[0].y);
  for (const p of pts.slice(1)) s.lineTo(p.x, p.y);
  for (const p of off.reverse()) s.lineTo(p.x, p.y);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth: width, bevelEnabled: false, curveSegments: 8 });
  geo.translate(0, 0, -width / 2);
  geo.rotateY(Math.PI / 2); // şekil (z, y) → dünya: x genişlik boyunca
  return mesh(geo, mat);
}

/**
 * Oobje Bony (71,5 × 31,5 × 81): iki yanda bükme boru çerçeve (önde ve arkada ayak, üstte derinlik boyunca
 * yuvarlak kemer), kemerin içinde tepsinin kalkık uçları, ortada düz tepsi; altta önü alçak kıvrık sac kutu
 * (üst panel = ara raf). Tekerlekli seçenekte boru altında 4 tekerlek (toplam yükseklik aynı: varsayım).
 */
function buildBony(g, it, S) {
  const W = it.w;
  const D = it.d;
  const H = it.h;
  const c = it.parts?.fabric ?? it.color;
  const mat = powder(c);
  const R = 0.95; // boru yarıçapı
  const T = 0.2; // sac kalınlığı
  const wheels = !!it.parts?.wheels;
  const wh = wheels ? 7.5 : 0;
  const fx = W / 2 - R;
  const fz = D / 2 - R;
  // Yan çerçeveler
  for (const sx of [-1, 1])
    g.add(tubePath([[sx * fx, wh, fz], [sx * fx, H - R, fz], [sx * fx, H - R, -fz], [sx * fx, wh, -fz]], R, mat, 6));
  const inner = W - 2 * R - 1.2; // çerçeveler arası
  const depth = D - 2 * R - 1; // sac derinliği
  const side = new THREE.MeshStandardMaterial({ color: mat.color, roughness: mat.roughness, metalness: mat.metalness, side: THREE.DoubleSide });
  // Önden bakınca yuvarlak köşeli sac kesit (x–y), derinlik boyunca (z) uzatılır.
  const sheet = (shape) => {
    const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 12 });
    geo.translate(0, 0, -depth / 2);
    return mesh(geo, side);
  };
  const roundRect = (x0, y0, x1, y1, r) => {
    const sh = new THREE.Shape();
    sh.moveTo(x0 + r, y0);
    sh.lineTo(x1 - r, y0);
    sh.absarc(x1 - r, y0 + r, r, -Math.PI / 2, 0, false);
    sh.lineTo(x1, y1 - r);
    sh.absarc(x1 - r, y1 - r, r, 0, Math.PI / 2, false);
    sh.lineTo(x0 + r, y1);
    sh.absarc(x0 + r, y1 - r, r, Math.PI / 2, Math.PI, false);
    sh.lineTo(x0, y0 + r);
    sh.absarc(x0 + r, y0 + r, r, Math.PI, Math.PI * 1.5, false);
    return sh;
  };
  // Üst tepsi: ortası düz, iki ucu yuvarlak kıvrımla çerçeve kemerine doğru kalkar (U kesit).
  const ty = S.trayY ?? 68;
  const tr = 6;
  const ux = inner / 2;
  const tray = new THREE.Shape();
  tray.moveTo(-ux, H - 3);
  tray.lineTo(-ux, ty + tr);
  tray.absarc(-ux + tr, ty + tr, tr, Math.PI, Math.PI * 1.5, false);
  tray.lineTo(ux - tr, ty);
  tray.absarc(ux - tr, ty + tr, tr, -Math.PI / 2, 0, false);
  tray.lineTo(ux, H - 3);
  tray.lineTo(ux - T, H - 3);
  tray.lineTo(ux - T, ty + tr);
  tray.absarc(ux - tr, ty + tr, tr - T, 0, -Math.PI / 2, true);
  tray.lineTo(-ux + tr, ty + T);
  tray.absarc(-ux + tr, ty + tr, tr - T, Math.PI * 1.5, Math.PI, true);
  tray.lineTo(-ux + T, H - 3);
  tray.closePath();
  g.add(sheet(tray));
  // Alt kutu: üst panel (ara raf), iki yan ve taban tek parça yuvarlak köşeli tüp; önü açık, altta ön dudak,
  // arkası kapalı (fotoğraf).
  const by = (S.boxBottom ?? 9) + wh * 0.4;
  const top = S.boxTop ?? 46;
  const rr = 7;
  const tube = roundRect(-ux, by, ux, top, rr);
  tube.holes.push(roundRect(-ux + T, by + T, ux - T, top - T, rr - T));
  g.add(sheet(tube));
  const back = new THREE.ShapeGeometry(roundRect(-ux + T, by + T, ux - T, top - T, rr - T), 12);
  g.add(mesh(back, side, 0, 0, -depth / 2 + 0.3));
  const lip = S.lip ?? 13;
  g.add(box(inner - 2 * T, lip - T, T, side, 0, by + T + (lip - T) / 2, depth / 2 - T / 2));
  if (wheels) {
    const rub = new THREE.MeshStandardMaterial({ color: 0x1e1e1e, roughness: 0.7 });
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        g.add(mesh(new THREE.CylinderGeometry(3.2, 3.2, 1.8, 20).rotateZ(Math.PI / 2), rub, sx * fx, 3.4, sz * fz));
        g.add(box(2.4, 3, 2.4, metal('#9da2a8'), sx * fx, 6.2, sz * fz));
      }
  }
}

export function buildConsole(it) {
  const S = it.shape ?? {};
  const g = new THREE.Group();
  if (S.style === 'ovalGlass') buildOvalGlass(g, it, S);
  else if (S.style === 'glassSides') buildGlassSides(g, it, S);
  else if (S.style === 'bony') buildBony(g, it, S);
  g.scale.setScalar(0.01);
  return g;
}
