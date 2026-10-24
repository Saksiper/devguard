// Gerçekçi görünüm için son işlem zinciri (ayrı parça olarak, ilk HD 3D/yürü kullanımında yüklenir):
// N8AO köşe/temas gölgesi (sahneyi kendisi çizer) → ton eşleme → SMAA kenar yumuşatma.
// Donanım kenar yumuşatması AO ile çalışmadığı için yumuşatma en sonda yapılır.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { N8AOPass } from 'n8ao';

export function createComposer(renderer, scene, camera, w, h) {
  const c = new EffectComposer(renderer, new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType }));
  c.setPixelRatio(renderer.getPixelRatio());
  c.setSize(w, h);
  const ao = new N8AOPass(scene, camera, w, h);
  ao.setQualityMode('Medium');
  Object.assign(ao.configuration, { aoRadius: 0.5, distanceFalloff: 1, intensity: 2.2, gammaCorrection: false });
  c.addPass(ao);
  c.addPass(new OutputPass());
  c.addPass(new SMAAPass());
  return { composer: c, ao };
}
