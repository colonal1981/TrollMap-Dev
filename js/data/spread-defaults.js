/**
 * Default six-rod trolling spread, initialized on app load.
 *
 * Each row is built with `newRodRow` from utils/rod-row.js so the schema
 * stays in one place. If you change the column list in `renderSpread()`,
 * update `newRodRow()` at the same time.
 *
 * Pattern: two A-rigs bow, two crankbaits mid, two flutter spoons stern.
 * The port/starboard pairs match each other for symmetry and to make
 * it easy to swap lures in/out as the bite changes.
 */

import { newRodRow } from '../utils/rod-row.js';

export const DEFAULT_SPREAD = [
  newRodRow({
    side: 'Port', position: 'Bow',
    reel: 'Spinning / 30lb 8-strand braid + 20lb fluoro leader',
    lure: 'A-Rig Medium (~2.65oz) – 4.6" Swimbait',
    color: 'Blueback Herring', depth: '25', lead: '95',
    notes: 'Port ledge channel',
  }),
  newRodRow({
    side: 'Starboard', position: 'Bow',
    reel: 'Spinning / 30lb 8-strand braid + 20lb fluoro leader',
    lure: 'A-Rig Medium (~2.65oz) – 4.6" Swimbait',
    color: 'Natural Pearl / Smoke', depth: '25', lead: '95',
    notes: 'Starboard ledge',
  }),
  newRodRow({
    side: 'Port', position: 'Mid',
    reel: 'Spinning / 30lb 8-strand braid + 20lb fluoro leader',
    lure: 'Flicker Minnow 11 – Crankbait',
    color: 'Blue / Silver Herring', depth: '28', lead: '106',
    notes: 'Port secondary flat',
  }),
  newRodRow({
    side: 'Starboard', position: 'Mid',
    reel: 'Spinning / 30lb 8-strand braid + 20lb fluoro leader',
    lure: 'Flicker Minnow 11 – Crankbait',
    color: 'Sexy Shad', depth: '28', lead: '106',
    notes: 'Starboard secondary flat',
  }),
  newRodRow({
    side: 'Port', position: 'Stern',
    reel: 'Spinning / 30lb 8-strand braid directly tied to swivel snap',
    lure: 'Flutter Spoon 2oz',
    color: 'Shattered Glass Silver', depth: '32', lead: '112',
    notes: 'Port deep flutter',
  }),
  newRodRow({
    side: 'Starboard', position: 'Stern',
    reel: 'Spinning / 30lb 8-strand braid directly tied to swivel snap',
    lure: 'Flutter Spoon 2oz',
    color: 'Chrome / Silver', depth: '32', lead: '112',
    notes: 'Starboard deep flutter',
  }),
];
