// Parametrik kanepe modeli (G×D×Y ve katalogdaki "shape" parametrelerinden).
// Yerel eksenler: x = genişlik, y = yukarı, +z = ön. Geometri cm ile kurulur, en sonda 1/100 ölçeklenir.
// Kumaş: fitilli kadife için dünya ölçekli fitil dokusu (her yüzde aynı fitil aralığı) + kadife parlaklığı.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const RIB_CM = 0.7; // fitil aralığı (fotoğraflardan: sırt minderinde ~60 fitil / 43 cm)
const RIBS_PER_TEX = 8;

let ribTexture = null;
function ribTex() {
  if (ribTexture) return ribTexture;
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = RIBS_PER_TEX * 16;
  const x = c.getContext('2d');
  for (let y = 0; y < c.height; y++) {
    const t = (y % 16) / 16; // 0..1 bir fitil içinde
    const v = Math.round(255 * (0.8 + 0.2 * Math.sin(Math.PI * t) ** 0.6));
    x.fillStyle = `rgb(${v},${v},${v})`;
    x.fillRect(0, y, c.width, 1);
  }
  ribTexture = new THREE.CanvasTexture(c);
  ribTexture.wrapS = ribTexture.wrapT = THREE.RepeatWrapping;
  ribTexture.colorSpace = THREE.SRGBColorSpace;
  return ribTexture;
}

/**
 * UV'leri dünya ölçüsüne göre yeniden yazar: fitiller her yüzde aynı aralıkta ve yatay görünür.
 * topRibs: üst yüzde fitillerin uzandığı eksen ('x' → ön kenara paralel, 'z' → önden arkaya).
 */
function worldRibUV(geo, topRibs = 'x') {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const uv = geo.attributes.uv;
  const k = 1 / (RIB_CM * RIBS_PER_TEX);
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i);
    const py = pos.getY(i);
    const pz = pos.getZ(i);
    const nx = Math.abs(nor.getX(i));
    const ny = Math.abs(nor.getY(i));
    const nz = Math.abs(nor.getZ(i));
    let u;
    let v;
    if (ny > 0.75) [u, v] = topRibs === 'x' ? [px, pz] : [pz, px];
    else if (nz >= nx) [u, v] = [px, py];
    else [u, v] = [pz, py];
    uv.setXY(i, u * k, v * k);
  }
  uv.needsUpdate = true;
  return geo;
}

function fabricMaterial(color, ribbed) {
  const c = new THREE.Color(color);
  // Kadife: hafif kenar parlaması (sheen); ortam yansıması düşük tutulur ki renk soluklaşmasın.
  const sheen = c.clone().lerp(new THREE.Color(0xffffff), 0.12);
  const m = new THREE.MeshPhysicalMaterial({
    color: c,
    roughness: 0.95,
    sheen: 0.6,
    sheenRoughness: 0.6,
    sheenColor: sheen,
    envMapIntensity: 0.35,
  });
  if (ribbed) {
    m.map = ribTex();
    m.bumpMap = ribTex();
    m.bumpScale = 0.9;
  }
  return m;
}

function rbox(w, h, d, r, mat, ribs) {
  const rr = Math.max(0.1, Math.min(r, w / 2 - 0.01, h / 2 - 0.01, d / 2 - 0.01));
  const geo = new RoundedBoxGeometry(w, h, d, 4, rr);
  if (ribs) worldRibUV(geo, ribs);
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export function buildSofa(it) {
  const S = it.shape ?? {};
  const W = it.w;
  const D = it.d;
  const H = it.h;
  const ribbed = S.fabric === 'corduroy';
  const fabric = fabricMaterial(it.parts?.fabric ?? it.color, ribbed);
  const wood = new THREE.MeshStandardMaterial({ color: new THREE.Color(it.parts?.legs ?? '#b5814d'), roughness: 0.55 });
  const soft = (it.parts?.backStyle ?? 'firm') === 'soft';

  const aw = S.armWidth ?? 20;
  const at = S.armTop ?? 62;
  const ab = S.armBottom ?? 15;
  const ar = S.armRadius ?? 8;
  const baseB = S.baseBottom ?? 16;
  const baseT = S.baseTop ?? 25;
  const seatW = W - 2 * aw;
  const seatD = it.dims?.seatDepth ?? D * 0.62;
  const seatH = it.dims?.seatHeight ?? 43;
  const frameT = S.backFrame ?? 10;
  const backT = S.backThickness ?? 20;
  const front = D / 2 - 1.5;
  const g = new THREE.Group();

  for (const sx of [-1, 1]) {
    const arm = rbox(aw, at - ab, D, ar, fabric, 'z');
    arm.position.set(sx * (W / 2 - aw / 2), (ab + at) / 2, 0);
    g.add(arm);
  }
  const base = rbox(seatW + 2, baseT - baseB, D - 4, 2, fabric, 'x');
  base.position.set(0, (baseB + baseT) / 2, -1);
  g.add(base);
  const frame = rbox(seatW + 2, at - 4 - baseT, frameT, 3, fabric, 'x');
  frame.position.set(0, (baseT + at - 4) / 2, -D / 2 + frameT / 2);
  g.add(frame);

  const nSeat = Math.max(1, S.seatCushions ?? 2);
  const cw = seatW / nSeat;
  for (let i = 0; i < nSeat; i++) {
    const c = rbox(cw - 0.8, seatH - baseT, seatD, 4, fabric, 'x');
    c.position.set(-seatW / 2 + cw * (i + 0.5), (baseT + seatH) / 2, front - seatD / 2);
    g.add(c);
  }

  const nBack = Math.max(1, S.backCushions ?? 2);
  const bw = seatW / nBack;
  const backFront = front - seatD;
  const bh = H - seatH + 2;
  const rec = ((S.backRecline ?? 8) * Math.PI) / 180;
  for (let i = 0; i < nBack; i++) {
    const pivot = new THREE.Group();
    pivot.position.set(-seatW / 2 + bw * (i + 0.5), seatH - 2, backFront - backT / 2);
    const c = rbox(bw - 0.8 + (soft ? 1.5 : 0), bh, backT + (soft ? 2 : 0), soft ? 8 : 4, fabric, 'x');
    c.position.y = bh / 2;
    pivot.add(c);
    pivot.rotation.x = -rec;
    g.add(pivot);
  }

  const legD = S.legDiameter ?? 5;
  const [ix, iz] = S.legInset ?? [12, 10];
  const legGeo = new THREE.CylinderGeometry(legD / 2, legD / 2, baseB, 20);
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, wood);
      leg.position.set(sx * (W / 2 - ix), baseB / 2, sz * (D / 2 - iz));
      leg.castShadow = true;
      g.add(leg);
    }

  g.scale.setScalar(0.01);
  return g;
}

