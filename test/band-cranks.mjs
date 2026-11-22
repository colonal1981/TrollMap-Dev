// Personal use only, not for distribution or resale; not for navigation.
//
// THE FOUR DD PLACEHOLDERS, KEPT FOR THE TESTS AND NOWHERE ELSE.
//
// Ryan, 2026-11-22, of 'DD1 Crankbait (14-18ft)' to 'DD4 Crankbait (25ft+)': "Either have it as an alias or remove the
// dd markings. Those were created because I don't know the brand of every crankbait. More of a place holder / guess".
// So his box lost DD2, DD3 and DD4 (no bait behind them) and DD1 became 'Deep Crankbait ~3", long lip (no label)'.
//
// The planner still models the four bands (LURE_KNOWLEDGE.crankbait_dd1 to crankbait_dd4), and many tests were written
// against one bait of each band with nothing of its own on it: no maker's depth, the band's speed, the band's weight.
// Those tests are about the band physics, not about what is in his box, so they keep their four baits here, exactly as
// they shipped, in the place they sat in the box. A test about HIS box imports TACKLE_INVENTORY itself.
import { TACKLE_INVENTORY } from '../js/data/tackle-inventory.js';

const like = TACKLE_INVENTORY.find((l) => l.id === 'cb_dd1');

export const BAND_CRANKS = Object.freeze([
  { ...like, id: 'cb_dd1', name: 'DD1 Crankbait (14-18ft)', type: 'crankbait_dd1', weightOz: 0.75 },
  { ...like, id: 'cb_dd2', name: 'DD2 Crankbait (16-20ft)', type: 'crankbait_dd2', weightOz: 0.75 },
  { ...like, id: 'cb_dd3', name: 'DD3 Crankbait (20-25ft)', type: 'crankbait_dd3', weightOz: 1.0 },
  { ...like, id: 'cb_dd4', name: 'DD4 Crankbait (25ft+)', type: 'crankbait_dd4', weightOz: 1.25 },
].map((l) => Object.freeze(l)));

/** His box with the four band baits where DD1 sits (the renamed DD1 is the first of them). */
export const BOX = Object.freeze(TACKLE_INVENTORY.flatMap((l) => (l.id === 'cb_dd1' ? BAND_CRANKS : [l])));
