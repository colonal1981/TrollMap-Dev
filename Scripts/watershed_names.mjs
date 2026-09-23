#!/usr/bin/env node
// Scripts/watershed_names.mjs -- the app's own names for a list of (common, scientific) pairs.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// build_watershed_fish.py reads fish from two outside sources (NatureServe via fishmap.org, and
// USGS NAS) that name them their own way: 2010 NatureServe says "Stizostedion vitreum", the app
// says "Walleye". This file is the ONLY place that translation happens, and it does not keep a
// vocabulary of its own. It asks the two things the app already owns:
//
//   registry/species_traits.json     the app's species, each with the binomial(s) its agency
//                                    source printed -- matched FIRST, because a binomial is one
//                                    fish and a common name is not ("bullhead" is four).
//   Worker/research/facts-util.js    RESEARCH_SPECIES_CANON for the common name, when the binomial
//                                    is not one the traits carry; uniqueResearchSpecies() for the
//                                    role -- a name the roster keeps is a TARGET.
//   registry/agency_lake_facts.json  for FORAGE: a name the roster drops is forage only if a state
//                                    agency writes it as something a predator eats (see
//                                    preyVocabulary). The rest are NON-GAME -- gar, American shad.
//
// A binomial two app species both claim is reported as ambiguous and not guessed at.
//
//   node Scripts/watershed_names.mjs <species_traits.json> <agency_lake_facts.json> < pairs.json
//   pairs.json: [{"common": "Smallmouth Bass", "scientific": "Micropterus dolomieu"}, ...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fu = await import(pathToFileURL(path.join(HERE, '..', 'Worker', 'research', 'facts-util.js')).href);

export function binomialKey(s) {
  // "Morone saxatilis X chrysops" and "Morone saxatilis x M. chrysops" are both the hybrid; a
  // plain binomial is genus + epithet, lower case, single spaces.
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function binomialIndex(traits) {
  const claims = new Map();                           // binomial -> Set(app name)
  const only = new Map();                             // binomial -> app name that lists ONLY it
  for (const [name, rows] of Object.entries((traits && traits.species) || {})) {
    const bins = new Set();
    for (const r of (Array.isArray(rows) ? rows : [])) {
      for (const part of String((r && r.scientific) || '').split(/[\/,]/)) {
        const k = binomialKey(part);
        if (k && /^[a-z]+ [a-z-]+$/.test(k)) bins.add(k);
      }
    }
    for (const b of bins) {
      if (!claims.has(b)) claims.set(b, new Set());
      claims.get(b).add(name);
      if (bins.size === 1) only.set(b, name);
    }
  }
  const index = new Map();
  const ambiguous = new Map();
  for (const [b, names] of claims) {
    if (names.size === 1) index.set(b, [...names][0]);
    else if (only.has(b)) index.set(b, only.get(b));   // Alabama Bass lists henshalli alone
    else ambiguous.set(b, [...names].sort());
  }
  return { index, ambiguous };
}

/**
 * The fish the state agencies themselves say a predator EATS, over every lake page we hold.
 *
 * "NOT A TARGET" IS NOT "PREY". The first run of the watershed build called every name the roster
 * drops a forage fish, because that is the canon's split -- and Longnose Gar came out as forage on
 * the Nolichucky, the Clinch and the Holston. The canon's non-targets are two different kinds of
 * fish: the herrings and shads things eat, and the gars and anadromous American shad that nothing
 * in these pages is written as eating.
 *
 * The line is drawn by the agencies' own sentences, through the app's own reader of them
 * (forageFromAgencyPages, which only reads inside a predator's write-up). Measured 2026-09-23 over
 * agency_lake_facts.json: 14 waters name what a predator eats, and between them they name exactly
 * Blueback Herring (9), Threadfin Shad (4), Gizzard Shad (4) and Alewife (3). A fish an agency
 * later writes as prey joins the vocabulary by that page, with no edit here.
 */
export function preyVocabulary(agencyDoc, readForage) {
  const rows = (agencyDoc && agencyDoc.rows) || {};
  const out = new Set();
  for (const pages of Object.values(rows)) {
    if (!Array.isArray(pages)) continue;
    for (const f of (readForage(pages).forage || [])) out.add(f);
  }
  return out;
}

export function nameAll(pairs, traits, util = fu, prey = null) {
  const { index, ambiguous } = binomialIndex(traits);
  // A KEY THE CANON HOLDS, NOT WHATEVER canonicalizeResearchSpecies() RETURNS. That function
  // normalises any string it is handed, so "Whitetail Shiner" came back as "Whitetail Shiner",
  // passed the roster filter, and was reported as a target -- measured on the first try of this
  // file. Only a name the canon already lists is an app species.
  const canon = util.RESEARCH_SPECIES_CANON || {};
  const canonOf = (common) => canon[String(common || '').toLowerCase().replace(/\s+/g, ' ').trim()] || null;
  return pairs.map(({ common, scientific }) => {
    const b = binomialKey(scientific);
    let name = index.get(b) || null;
    let by = name ? 'binomial' : null;
    if (!name && ambiguous.has(b)) {
      return { common, scientific, name: null, by: null, role: null, ambiguous: ambiguous.get(b) };
    }
    if (!name) {
      name = canonOf(common);
      by = name ? 'common name' : null;
    }
    let role = null;
    if (name) {
      if (util.uniqueResearchSpecies([name]).length) role = 'target';
      else if (prey && prey.has(name)) role = 'forage';
      else role = 'non-game';
    }
    return { common, scientific, name, by, role };
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const traits = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  let prey = null;
  if (process.argv[3]) {
    const det = await import(pathToFileURL(path.join(HERE, '..', 'Worker', 'research', 'deterministic.js')).href);
    prey = preyVocabulary(JSON.parse(fs.readFileSync(process.argv[3], 'utf8')), det.forageFromAgencyPages);
  }
  const pairs = JSON.parse(fs.readFileSync(0, 'utf8'));
  process.stdout.write(JSON.stringify(nameAll(pairs, traits, fu, prey)));
}
