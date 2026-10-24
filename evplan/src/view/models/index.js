// Katalogdaki shape.type → parametrik model kurucu.
import { buildSofa } from './sofa.js';
import { buildCabinets } from './cabinets.js';
import { buildTv } from './tv.js';
import { buildTambour } from './tambour.js';
import { buildBed, buildCase, buildChair, buildFridge, buildOfficeChair, buildRug, buildShelf, buildTable, buildWasher } from './generic.js';

export const MODEL_BUILDERS = {
  sofa: buildSofa,
  cabinets: buildCabinets,
  tv: buildTv,
  tambour: buildTambour,
  table: buildTable,
  chair: buildChair,
  officeChair: buildOfficeChair,
  bed: buildBed,
  case: buildCase,
  shelf: buildShelf,
  fridge: buildFridge,
  washer: buildWasher,
  rug: buildRug,
};

export function buildModel(it) {
  const type = it.shape?.type ?? (it.modules ? 'cabinets' : null);
  const fn = type && MODEL_BUILDERS[type];
  return fn ? fn(it) : null;
}
