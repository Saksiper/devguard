// Yapay bitkiler (shape.type 'plant'): beton saksı (isteğe bağlı ayaklı sehpa), gövde ve yapraklar.
// shape.kind: 'olive' (ince gövde, oval tepe, küçük dar yapraklar), 'banana' (üç kalın gövde, iri kürek
// yapraklar), 'alocasia' (uzun saplı, kalp biçimli iri yapraklar). Yerel eksenler: x/z yatay, y yukarı; cm.
// Yapraklar tek bir birleşik geometride (ışın izleme ve telefon için çizim çağrısı az olsun).
// Saksı/sehpa ölçüleri üreticiden; tepe genişliği ve yaprak yerleşimi fotoğraftan tahmini.

import * as THREE from 'three';

const col = (c) => new THREE.Color(c);

function rnd(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

/**
 * Yaprak geometrisi (birleşik): her yaprak tabanı p'de, yönü dir boyunca, genişlik profili m(u), sarkma ve
 * orta damar katlaması ile. Köşe renkleri: orta damar biraz açık.
 */
class LeafBatch {
  constructor() {
    this.pos = [];
    this.col = [];
    this.idx = [];
  }

  add(p, dir, len, wid, { profile, u0 = 0, droop = 0.25, fold = 0.06, nu = 8, nv = 4, color, vein, veinWidth = 4 }) {
    const Y = dir.clone().normalize();
    const up = Math.abs(Y.y) > 0.98 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const X = new THREE.Vector3().crossVectors(up, Y).normalize();
    const Z = new THREE.Vector3().crossVectors(X, Y).normalize(); // yaprak yüzü (çoğunlukla yukarı)
    const base = this.pos.length / 3;
    const c0 = col(color);
    const c1 = col(vein ?? color);
    for (let i = 0; i <= nu; i++) {
      const u = u0 + ((1 - u0) * i) / nu;
      const hw = (wid / 2) * profile(u);
      const along = u * len;
      for (let j = 0; j <= nv; j++) {
        const v = (j / nv) * 2 - 1;
        const across = v * hw;
        // katlama: orta damardan iki yana hafif V (yaprak yüzüne dik); sarkma: uca doğru yere doğru kıvrılır
        const q = new THREE.Vector3().copy(p).addScaledVector(Y, along).addScaledVector(X, across).addScaledVector(Z, fold * Math.abs(v) * hw);
        q.y -= droop * Math.max(0, u) ** 2 * len;
        this.pos.push(q.x, q.y, q.z);
        const c = c0.clone().lerp(c1, Math.max(0, 1 - Math.abs(v) * veinWidth));
        this.col.push(c.r, c.g, c.b);
      }
    }
    const row = nv + 1;
    for (let i = 0; i < nu; i++)
      for (let j = 0; j < nv; j++) {
        const a = base + i * row + j;
        this.idx.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
      }
  }

  mesh(mat) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat);
    m.castShadow = m.receiveShadow = true;
    return m;
  }
}

function tube(points, r0, r1, mat, seg = 10) {
  const curve = new THREE.CatmullRomCurve3(points);
  const geo = new THREE.TubeGeometry(curve, Math.max(4, points.length * 4), 1, seg, false);
  // Yarıçapı uca doğru incelt.
  const pos = geo.attributes.position;
  const n = geo.parameters.tubularSegments;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const r = r0 + (r1 - r0) * t;
    const c = curve.getPointAt(t);
    for (let j = 0; j <= seg; j++) {
      const k = i * (seg + 1) + j;
      const v = new THREE.Vector3().fromBufferAttribute(pos, k).sub(c).normalize().multiplyScalar(r).add(c);
      pos.setXYZ(k, v.x, v.y, v.z);
    }
  }
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = m.receiveShadow = true;
  return m;
}

/** Beton saksı (silindir, alt kenarı yuvarlatılmış) + üstte kabuk/çakıl; isteğe bağlı ahşap ayaklı sehpa. */
function pot(g, S, parts) {
  const D = parts.potD ?? S.potD ?? 25;
  const H = parts.potH ?? S.potH ?? 25;
  const standH = parts.stand ? (parts.standH ?? S.standH ?? 30) : 0;
  if (parts.stand) {
    const wood = new THREE.MeshStandardMaterial({ color: col(parts.stand), roughness: 0.55 });
    const r = D / 2 - 1;
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      const leg = new THREE.Mesh(new THREE.BoxGeometry(1.8, standH + 6, 1.8), wood);
      leg.position.set(Math.cos(a) * r, (standH + 6) / 2, Math.sin(a) * r);
      leg.castShadow = true;
      g.add(leg);
    }
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.9, 6, 32), wood);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = standH * 0.35;
    g.add(ring);
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(D / 2 - 1.5, D / 2 - 1.5, 1.6, 32), wood);
    plate.position.y = standH - 0.8;
    g.add(plate);
  }
  if (parts.pot !== null && parts.pot !== 'none') {
    const mat = new THREE.MeshStandardMaterial({ color: col(parts.pot ?? '#cdcec7'), roughness: parts.potRough ?? 0.85 });
    const prof = [
      [0, 0],
      [D / 2 - 1.5, 0],
      [D / 2 - 0.2, 1.2],
      [D / 2, 3],
      [D / 2, H],
      [D / 2 - 1.2, H],
      [D / 2 - 1.2, H - 2],
    ].map(([x, y]) => new THREE.Vector2(x, y));
    const body = new THREE.Mesh(new THREE.LatheGeometry(prof, 40), mat);
    body.position.y = standH;
    body.castShadow = body.receiveShadow = true;
    g.add(body);
    const topping = new THREE.Mesh(
      new THREE.CircleGeometry(D / 2 - 1.2, 32),
      new THREE.MeshStandardMaterial({ color: col(S.topping ?? '#8a6a52'), roughness: 1 }),
    );
    topping.rotation.x = -Math.PI / 2;
    topping.position.y = standH + H - 2.5;
    g.add(topping);
  }
  return { top: standH + (parts.pot === null || parts.pot === 'none' ? 2 : H - 2.5), base: standH };
}

function buildOlive(g, it, S, { top, base }, R) {
  const H = it.h;
  const trunkMat = new THREE.MeshStandardMaterial({ color: col(S.trunk ?? '#463636'), roughness: 0.8 });
  const cb = base + (S.canopyFrom ?? 80); // tepenin altı (yerden, sehpa hariç)
  const cw = (it.w / 2) * 0.95;
  const crown = new THREE.Vector3(0, (cb + H) / 2, 0);
  g.add(tube([new THREE.Vector3(0, top - 4, 0), new THREE.Vector3(1.5, top + 25, 0.5), new THREE.Vector3(-1, cb, -0.8), new THREE.Vector3(0.5, H - 15, 0.5)], 1.6, 0.6, trunkMat, 8));
  const leaves = new LeafBatch();
  const narrow = (u) => Math.max(0, Math.sin(Math.PI * u)) ** 0.8;
  const tips = [];
  // Tepedeki dallar: gövdeden çapraz yukarı.
  for (let k = 0; k < 20; k++) {
    const a = R() * Math.PI * 2;
    const y0 = cb + R() * (H - cb) * 0.7;
    const len = 12 + R() * cw * 0.7;
    const end = new THREE.Vector3(Math.cos(a) * len, y0 + 10 + R() * 25, Math.sin(a) * len);
    g.add(tube([new THREE.Vector3(0, y0, 0), new THREE.Vector3(end.x * 0.5, (y0 + end.y) / 2 + 3, end.z * 0.5), end], 0.5, 0.2, trunkMat, 5));
    tips.push({ from: new THREE.Vector3(0, y0, 0), to: end });
  }
  // Yapraklar: dalların çevresinde ve oval tepenin içinde.
  const n = S.leaves ?? 1300;
  for (let i = 0; i < n; i++) {
    const t = tips[i % tips.length];
    const s = 0.25 + R() * 0.8;
    const p = new THREE.Vector3().lerpVectors(t.from, t.to, s).add(new THREE.Vector3((R() - 0.5) * 18, (R() - 0.5) * 16, (R() - 0.5) * 18));
    const e = new THREE.Vector3((p.x - crown.x) / cw, (p.y - crown.y) / ((H - cb) / 2), (p.z - crown.z) / cw);
    if (e.length() > 1.05) p.sub(crown).multiplyScalar(1 / e.length()).add(crown);
    const dir = new THREE.Vector3(R() - 0.5, 0.4 + R() * 0.6, R() - 0.5);
    const shade = R() < 0.3 ? S.leafBack ?? '#8a957a' : S.leaf ?? '#525936';
    leaves.add(p, dir, 6 + R() * 2.5, 1.2 + R() * 0.4, { profile: narrow, droop: 0.1, fold: 0, nu: 2, nv: 1, color: shade });
  }
  // Saksının hemen üstünde küçük alt sürgün (fotoğraftaki gibi).
  for (let i = 0; i < 70; i++) {
    const p = new THREE.Vector3((R() - 0.5) * 14, top + 5 + R() * 30, (R() - 0.5) * 14);
    leaves.add(p, new THREE.Vector3(R() - 0.5, 0.6, R() - 0.5), 5 + R() * 2, 1.1, { profile: narrow, droop: 0.1, fold: 0, nu: 2, nv: 1, color: S.leaf ?? '#525936' });
  }
  g.add(leaves.mesh(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, side: THREE.DoubleSide })));
}

function buildBanana(g, it, S, { top, base }, R) {
  const H = it.h;
  const fib = new THREE.MeshStandardMaterial({ color: col(S.trunk ?? '#9d866f'), roughness: 0.9 });
  const green = new THREE.MeshStandardMaterial({ color: col(S.stem ?? '#6f8a3a'), roughness: 0.6 });
  const stemTop = base + (S.canopyFrom ?? 95); // yaprakların başladığı gövde tepesi (ana gövde biraz daha uzun)
  const leaves = new LeafBatch();
  // Kürek yaprak: dar tabandan hızla genişler, ucu yuvarlak.
  const paddle = (u) => Math.min(1, u * 6) ** 0.6 * (u > 0.82 ? Math.max(0, Math.cos(((u - 0.82) / 0.18) * (Math.PI / 2))) ** 0.5 : 1);
  const trunks = [
    [-3.5, -2.5, 1.0],
    [4, -1, 0.9],
    [0, 4, 0.8],
  ];
  trunks.forEach(([x, z, k], ti) => {
    const ht = top + (stemTop - top) * k;
    g.add(tube([new THREE.Vector3(x, top - 3, z), new THREE.Vector3(x * 1.1, (top + ht) / 2, z * 1.1), new THREE.Vector3(x * 1.25, ht, z * 1.25)], 5.8, 4.0, fib, 12));
    // Her gövdenin tepesinden 4 yaprak: yeşil sap + iri kürek yaprak; üsttekiler daha dik (fotoğraftaki gibi).
    const nL = 4;
    for (let i = 0; i < nL; i++) {
      const a = R() * Math.PI * 2;
      const upright = i / (nL - 1); // 0: alt, yatık — 1: üst, dik
      const pet = 14 + R() * 18 + upright * 25;
      const p0 = new THREE.Vector3(x * 1.25, ht, z * 1.25);
      const p1 = p0.clone().add(new THREE.Vector3(Math.cos(a) * pet * (0.4 - upright * 0.25), pet, Math.sin(a) * pet * (0.4 - upright * 0.25)));
      g.add(tube([p0, p0.clone().lerp(p1, 0.5), p1], 1.6, 1.0, green, 6));
      const len = Math.max(48, Math.min(H - p1.y + 25, 66 + R() * 22));
      const dir = new THREE.Vector3(Math.cos(a), 0.25 + upright * 1.1 + R() * 0.3, Math.sin(a));
      leaves.add(p1, dir, len, 28 + R() * 8, { profile: paddle, droop: 0.32 - upright * 0.18 + R() * 0.1, fold: 0.1, nu: 12, nv: 4, color: S.leaf ?? '#3c6018', vein: S.vein ?? '#7f9a45' });
    }
  });
  g.add(leaves.mesh(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, side: THREE.DoubleSide })));
}

function buildAlocasia(g, it, S, { top, base }, R) {
  const H = it.h;
  const stemMat = new THREE.MeshStandardMaterial({ color: col(S.stem ?? '#7c8f4e'), roughness: 0.6 });
  const leaves = new LeafBatch();
  // Ok/kalp biçimi: petiolün tutunduğu yerin altında iki geniş kulak, sivri uç.
  const sagittate = (u) => (u < 0 ? 0.95 + u * 2 : u < 0.22 ? 0.95 + u * 0.25 : Math.max(0, 1 - (u - 0.22) / 0.78) ** 0.85);
  const n = S.leaves ?? 12;
  const reach = it.w / 2;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + R() * 0.5;
    const hFrac = 0.35 + R() * 0.55;
    const from = base + (S.canopyFrom ?? 85);
    const tipY = from + (H - from - 35) * hFrac;
    const out = reach * (0.35 + R() * 0.4); // saplar geniş yelpaze açar
    const end = new THREE.Vector3(Math.cos(a) * out, tipY, Math.sin(a) * out);
    g.add(tube([new THREE.Vector3(Math.cos(a) * 2, top - 2, Math.sin(a) * 2), new THREE.Vector3(Math.cos(a) * out * 0.3, (top + tipY) / 2 + 8, Math.sin(a) * out * 0.3), end], 1.0, 0.6, stemMat, 6));
    const len = 44 + R() * 16;
    const dir = new THREE.Vector3(Math.cos(a), 0.35 + R() * 0.6, Math.sin(a));
    leaves.add(end, dir, len, len * 0.75, { profile: sagittate, u0: -0.2, droop: 0.22 + R() * 0.16, fold: 0.1, nu: 12, nv: 6, color: S.leaf ?? '#36502a', vein: S.vein ?? '#7d9a5e', veinWidth: 10 });
  }
  g.add(leaves.mesh(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: THREE.DoubleSide })));
}

export function buildPlant(it) {
  const S = it.shape ?? {};
  const parts = it.parts ?? {};
  const g = new THREE.Group();
  const at = pot(g, S, parts);
  const R = rnd([...String(it.ref ?? 'bitki')].reduce((a, c) => a * 31 + c.charCodeAt(0), 7));
  if (S.kind === 'banana') buildBanana(g, it, S, at, R);
  else if (S.kind === 'alocasia') buildAlocasia(g, it, S, at, R);
  else buildOlive(g, it, S, at, R);
  g.scale.setScalar(0.01);
  return g;
}
