// The unit that travels with the value, and nothing else.
//
// Ryan, 2026-08-16, on a river running about four thousand cubic feet a second: *"doesn't look
// like the flow rate changed"* — the card read `Flow 4 ft³/s`. NWPS publishes discharge in KCFS
// and USGS publishes it in ft3/s, and both used to arrive in a field called `flow`.
//
// The first fix normalised kcfs but kept two escape hatches, and BOTH of them were the same
// thousandfold bug wearing a different hat:
//
//   st.secondaryUnit || (j.flood && j.flood.flowUnits)   fall back to the flood table
//   if (!u) return v;                                     absent unit means cfs
//
// Measured against api.water.noaa.gov on 2026-08-16:
//
//   GADS1  Congaree at Congaree NP         secondaryUnit "kcfs"   flood.flowUnits "cfs"
//   WATS1  Wateree River at the dam        secondaryUnit "kcfs"   flood.flowUnits "cfs"
//   AUGG1  Savannah River at Augusta       secondaryUnit "kcfs"   flood.flowUnits "cfs"
//   KEOS1  Seneca River at Keowee Dam      secondaryUnit "kcfs"   flood.flowUnits "cfs"
//   CLTT1  Little Tennessee at Chilhowee   secondaryUnit ""       flood.flowUnits "cfs"
//
// Four for four the two fields disagree, and GADS1 settles which is right: 4.17 kcfs is the
// Congaree in August; 4.17 cfs is a ditch. `flood.flowUnits` describes the flood threshold
// table, a different quantity that happens to share a word. And CLTT1 proves the empty string
// is not hypothetical.
import { nwpsFlowCfs } from '../Worker/conditions.js';
import { readFileSync } from 'node:fs';

let fails = 0;
const check = (name, cond, got) => {
  if (cond) { console.log(`  ok   ${name}`); return; }
  fails++; console.log(`  FAIL ${name}${got === undefined ? '' : ` — got ${JSON.stringify(got)}`}`);
};

console.log('== nwpsFlowCfs ==');
check('kcfs scales by a thousand', nwpsFlowCfs(4.17, 'kcfs') === 4170, nwpsFlowCfs(4.17, 'kcfs'));
check('kcfs rounds to whole cfs', nwpsFlowCfs(1.9345, 'kcfs') === 1935, nwpsFlowCfs(1.9345, 'kcfs'));
check('cfs passes through', nwpsFlowCfs(4170, 'cfs') === 4170, nwpsFlowCfs(4170, 'cfs'));
check('ft3/s passes through', nwpsFlowCfs(4170, 'ft3/s') === 4170, nwpsFlowCfs(4170, 'ft3/s'));
check('case and padding tolerated', nwpsFlowCfs(4.17, ' KCFS ') === 4170, nwpsFlowCfs(4.17, ' KCFS '));

// The three that used to leak.
check('empty string is not cfs', nwpsFlowCfs(4.17, '') === null, nwpsFlowCfs(4.17, ''));
check('undefined is not cfs', nwpsFlowCfs(4.17, undefined) === null, nwpsFlowCfs(4.17, undefined));
check('null is not cfs', nwpsFlowCfs(4.17, null) === null, nwpsFlowCfs(4.17, null));
check('an unknown unit is refused, not passed raw',
  nwpsFlowCfs(4.17, 'cms') === null, nwpsFlowCfs(4.17, 'cms'));

check('no value is null whatever the unit', nwpsFlowCfs(null, 'kcfs') === null, nwpsFlowCfs(null, 'kcfs'));
check('NaN is null', nwpsFlowCfs(NaN, 'kcfs') === null, nwpsFlowCfs(NaN, 'kcfs'));
check('zero is a reading, not an absence', nwpsFlowCfs(0, 'cfs') === 0, nwpsFlowCfs(0, 'cfs'));
check('zero kcfs is zero cfs', nwpsFlowCfs(0, 'kcfs') === 0, nwpsFlowCfs(0, 'kcfs'));

// A REGRESSION GUARD ON THE SOURCE, because the defect was never in the arithmetic — it was in
// which field the arithmetic was handed. `flood.flowUnits` may be carried, but it may never be
// consulted for the units of an observation.
console.log('\n== flood.flowUnits is never used as an observation unit ==');
{
  const src = readFileSync(new URL('../Worker/conditions.js', import.meta.url), 'utf8');
  const code = src.split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))     // comments name it on purpose
    .join('\n');
  check('no flowUnits fallback in the flow expression',
    !/nwpsFlowCfs\([^)]*flowUnits/.test(code),
    (/nwpsFlowCfs\([^)]*flowUnits[^)]*\)/.exec(code) || [])[0]);
  check('flow_reported_units does not borrow the flood table',
    !/flow_reported_units:[^\n]*flowUnits/.test(code),
    (/flow_reported_units:[^\n]*/.exec(code) || [])[0]);
}

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURES'}`);
process.exit(fails ? 1 : 0);
