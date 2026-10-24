// Yuvarlak uçlu (hap biçimli) gövde + dikey çıtalı sürgü kapaklar + ince ayaklar (ör. JYSK LYNGVIG).
// Yerel eksenler: x genişlik, y yukarı, +z ön; cm.
import * as THREE from 'three';

let fluteTexture = null;
function fluteTex() {
  if (fluteTexture) return fluteTexture;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 4;
  const x = c.getContext('2d');
  for (let i = 0; i < 64; i++) {
    const t = (i % 16) / 16; // bir çıta: ortası açık, kenarları koyu
    const v = Math.round(255 * (0.72 + 0.28 * Math.sin(Math.PI * t)));
    x.fillStyle = `rgb(${v},${v},${v})`;
    x.fillRect(i, 0, 1, 4);
  }
  fluteTexture = new THREE.CanvasTexture(c);
  fluteTexture.wrapS = fluteTexture.wrapT = THREE.RepeatWrapping;
  fluteTexture.colorSpace = THREE.SRGBColorSpace;
  return fluteTexture;
}

function stadium(w, d) {
  const r = d / 2;
  const s = new THREE.Shape();
  s.moveTo(-w / 2 + r, -r);
  s.lineTo(w / 2 - r, -r);
  s.absarc(w / 2 - r, 0, r, -Math.PI / 2, Math.PI / 2, false);
  s.lineTo(-w / 2 + r, r);
  s.absarc(-w / 2 + r, 0, r, Math.PI / 2, (3 * Math.PI) / 2, false);
  return s;
}

/** Şekli yukarı doğru uzatılmış katı (y ekseni), yan yüzlerde çıta dokusu için u = çevre boyunca cm. */
function slab(w, d, h, mat, flutes = false) {
  const geo = new THREE.ExtrudeGeometry(stadium(w, d), { depth: h, bevelEnabled: false, curveSegments: 24 });
  geo.rotateX(-Math.PI / 2); // şekil xz düzlemine, yükseklik +y
  if (flutes) {
    const pos = geo.attributes.position;
    const nor = geo.attributes.normal;
    const uv = geo.attributes.uv;
    const pitch = 2.6; // cm, bir çıta
    const per = 4; // dokuda 4 çıta
    for (let i = 0; i < pos.count; i++) {
      if (Math.abs(nor.getY(i)) > 0.5) continue; // üst/alt yüz
      const px = pos.getX(i);
      const pz = pos.getZ(i);
      const r = d / 2;
      // Çevre boyunca yaklaşık yay uzunluğu: düz kısımda x, uçlarda açıya göre.
      let u;
      const cx = Math.max(-w / 2 + r, Math.min(w / 2 - r, px));
      if (Math.abs(px) <= w / 2 - r) u = pz > 0 ? px : -px + 4 * w;
      else u = cx + Math.atan2(pz, px - cx) * r;
      uv.setXY(i, u / (pitch * per), pos.getY(i) / 50);
    }
  }
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export function buildTambour(it) {
  const S = it.shape ?? {};
  const legH = S.legHeight ?? 17;
  const bodyH = it.h - legH;
  const g = new THREE.Group();
  const fl = fluteTex().clone();
  fl.needsUpdate = true;
  const sideMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(S.wood ?? it.color), map: fl, roughness: 0.6 });
  const topMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(S.top ?? S.wood ?? it.color), roughness: 0.55 });
  const legMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(S.legs ?? S.wood ?? it.color), roughness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x3a2a1e, roughness: 0.8 });

  const body = slab(it.w - 1.6, it.d - 1.6, bodyH - 3.2, sideMat, true);
  body.position.y = legH + 1.6;
  const top = slab(it.w, it.d, 1.8, topMat);
  top.position.y = it.h - 1.8;
  const bottom = slab(it.w - 0.4, it.d - 0.4, 1.6, topMat);
  bottom.position.y = legH;
  g.add(body, top, bottom);
  // Orta birleşimde iki kulp oyuğu.
  for (const sx of [-1, 1]) {
    const slot = new THREE.Mesh(new THREE.BoxGeometry(1.4, 9, 1), dark);
    slot.position.set(sx * 2.2, legH + bodyH * 0.62, it.d / 2 - 0.7);
    g.add(slot);
  }
  // Ayaklar + alt çerçeve.
  const ix = S.legInset?.[0] ?? it.w * 0.12;
  const iz = S.legInset?.[1] ?? 6;
  const legGeo = new THREE.CylinderGeometry(1.8, 1.6, legH, 16);
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, legMat);
      leg.position.set(sx * (it.w / 2 - ix), legH / 2, sz * (it.d / 2 - iz));
      leg.castShadow = true;
      g.add(leg);
    }
  for (const sz of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(it.w - 2 * ix, 2.5, 2), legMat);
    rail.position.set(0, legH - 3, sz * (it.d / 2 - iz));
    g.add(rail);
  }
  g.scale.setScalar(0.01);
  return g;
}
