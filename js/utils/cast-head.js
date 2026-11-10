/**
 * cast-head.js — the jighead a paddle tail goes on when nothing has fitted one.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 11/7, of his Moultrie plan: "the casting stop doesn't say what size jighead or color of swimbait". A trolled
 * swimbait has the head capBaitDepth() fitted on its leg; a rod that is only ever cast had none. This is the lightest
 * head he owns that the bait carries (jigheadRangeOz(): a 5" takes 3/4 to 1 oz). The lightest is MINE, for a slow
 * count-down. One copy, read by the stop cards (plan-to-timeline.js) and the depth ladder (plan-assemble.js).
 */
import { TACKLE_INVENTORY, JIGHEADS_OWNED_OZ } from '../data/tackle-inventory.js';
import { jigheadRangeOz } from '../data/lure-knowledge.js';

export function castHeadOz(lureName) {
  const l = TACKLE_INVENTORY.find((x) => x && x.name === lureName);
  const range = l && jigheadRangeOz(l.lengthIn, l.type);
  if (!range) return null;
  const fits = JIGHEADS_OWNED_OZ.filter((w) => w >= range.startOz - 1e-9 && w <= range.maxOz + 1e-9);
  return fits.length ? fits[0] : null;
}
