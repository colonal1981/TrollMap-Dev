#!/usr/bin/env node
// Simple parity checker for lake-keys — can be run without vitest: node test/check-lake-keys-parity.mjs
import { LAKE_NAME_TO_R2_KEY as frontendMap, resolveR2Key } from '../js/data/lake-keys.js';
import { SUPPLEMENTAL_KEY_MAP as workerMap, resolveSupplementalKeyWorker } from '../Worker/research/limnology.js';

const feSize = Object.keys(frontendMap).length;
const wkSize = Object.keys(workerMap).length;

console.log(`Frontend map: ${feSize} entries`);
console.log(`Worker map: ${wkSize} entries`);

if (feSize !== wkSize) {
  console.error(`❌ Size mismatch: frontend ${feSize} vs worker ${wkSize}`);
  process.exit(1);
}

const feJson = JSON.stringify(frontendMap, Object.keys(frontendMap).sort());
const wkJson = JSON.stringify(workerMap, Object.keys(workerMap).sort());

if (feJson !== wkJson) {
  console.error('❌ Maps not deep equal');
  const feKeys = new Set(Object.keys(frontendMap));
  const wkKeys = new Set(Object.keys(workerMap));
  for (const k of feKeys) {
    if (!wkKeys.has(k)) console.error(`Missing in worker: ${k}`);
    else if (frontendMap[k] !== workerMap[k]) console.error(`Value mismatch ${k}: FE ${frontendMap[k]} vs WK ${workerMap[k]}`);
  }
  for (const k of wkKeys) {
    if (!feKeys.has(k)) console.error(`Extra in worker: ${k}`);
  }
  process.exit(1);
}

console.log('✅ Maps deep equal');

const samples = [
  'Lake Wateree, SC',
  'Lake Murray, SC',
  'Catawba Narrows, SC/NC',
  'Fort Loudoun Lake, TN',
  'ACE Basin / Edisto, SC',
  'Lake Marion, SC',
];

for (const name of samples) {
  const fe = resolveR2Key(name);
  const wk = resolveSupplementalKeyWorker(name);
  if (fe !== wk) {
    console.error(`❌ Resolver mismatch for "${name}": FE ${fe} vs WK ${wk}`);
    process.exit(1);
  }
  console.log(`✓ ${name} → ${fe}`);
}

console.log('✅ All resolvers agree');
console.log('✅ Lake-keys parity check passed');
