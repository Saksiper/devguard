// Ağır kontrolleri (geçiş ızgarası) arayüzü dondurmadan arka planda çalıştırır.
import { buildPlanModel } from './core/plan.js';
import { runChecks } from './core/checks.js';

let model = null;
let planKey = null;

self.onmessage = (e) => {
  const { id, plan, items } = e.data;
  try {
    const key = JSON.stringify(plan);
    if (key !== planKey) {
      model = buildPlanModel(plan);
      planKey = key;
    }
    const r = runChecks(model, items, { passage: true });
    self.postMessage({ id, result: { issues: r.issues, passage: r.passage, metrics: r.metrics, itemState: [...r.itemState] } });
  } catch (err) {
    self.postMessage({ id, error: String(err?.stack ?? err) });
  }
};
