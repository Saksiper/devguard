// Katalogdaki shape.type → parametrik model kurucu.
import { buildSofa, buildSofaL } from './sofa.js';
import { buildCabinets } from './cabinets.js';
import { buildTv } from './tv.js';
import { buildTambour } from './tambour.js';
import {
  buildBed,
  buildBentwood,
  buildCase,
  buildChair,
  buildFridge,
  buildOfficeChair,
  buildRug,
  buildShelf,
  buildSwivel,
  buildTable,
  buildTrestle,
  buildWasher,
} from './generic.js';

export const MODEL_BUILDERS = {
  sofa: buildSofa,
  sofaL: buildSofaL,
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
  swivel: buildSwivel,
  trestle: buildTrestle,
  bentwood: buildBentwood,
};

export function buildModel(it) {
  const type = it.shape?.type ?? (it.modules ? 'cabinets' : null);
  const fn = type && MODEL_BUILDERS[type];
  return fn ? fn(it) : null;
}
