// Televizyon: ince ekran + ayak (G×D×Y kutusunun içinde). Yerel eksenler: x genişlik, y yukarı, +z ön; cm.
import * as THREE from 'three';

export function buildTv(it) {
  const g = new THREE.Group();
  const screenH = it.shape?.panelHeight ?? it.h - Math.min(6, it.h * 0.08);
  const standH = it.h - screenH;
  const t = it.shape?.panelDepth ?? 4.5; // panel kalınlığı
  const body = new THREE.MeshStandardMaterial({ color: 0x1b1d22, roughness: 0.45, metalness: 0.3 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x07090d, roughness: 0.08, metalness: 0.1, clearcoat: 1 });
  const panel = new THREE.Mesh(new THREE.BoxGeometry(it.w, screenH, t), body);
  panel.position.set(0, standH + screenH / 2, -it.d / 2 + it.d * 0.35);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(it.w - 1.6, screenH - 1.6), glass);
  screen.position.set(0, panel.position.y, panel.position.z + t / 2 + 0.05);
  const parts = [panel, screen];
  const F = it.shape?.feet;
  if (F) {
    // İki uçta ince ayaklar (ör. Samsung Q60: ayak tabanı 89,6 × 22,4 cm).
    for (const sx of [-1, 1]) {
      const foot = new THREE.Mesh(new THREE.BoxGeometry(5, 1.4, F.depth * 0.95), body);
      foot.position.set((sx * F.span) / 2 - sx * 2.5, 0.7, 0);
      const post = new THREE.Mesh(new THREE.BoxGeometry(3, standH + 6, 1.6), body);
      post.position.set((sx * F.span) / 2 - sx * 2.5, (standH + 6) / 2, panel.position.z - t / 2 - 0.8);
      parts.push(foot, post);
    }
  } else {
    const neck = new THREE.Mesh(new THREE.BoxGeometry(8, standH + 8, 3), body);
    neck.position.set(0, (standH + 8) / 2, panel.position.z - t / 2 - 1);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(Math.min(45, it.w * 0.35), 1.6, it.d * 0.9), body);
    foot.position.set(0, 0.8, 0);
    parts.push(neck, foot);
  }
  for (const m of parts) {
    m.castShadow = true;
    g.add(m);
  }
  g.scale.setScalar(0.01);
  return g;
}
