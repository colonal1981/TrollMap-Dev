// THE CHORD IS A DIRECTION THE BOAT NEVER TRAVELS.
//
// Both planners costed a trolling leg by taking the bearing of the straight line between its two
// ends and resolving the wind and the current against that one number. On a leg that wraps a point
// or runs into a pocket, that bearing is a direction the boat never actually goes; on a leg that
// doubles back it is close to meaningless. The measured case below is the sharp one: a hairpin
// whose chord runs due north, perpendicular to both of its arms, so the chord method reports no
// wind at all and charges the still-water price for a leg that is half spent on the nose.
//
// AND THE AVERAGE IS NOT THE FIX. Amps go as mph^1.756, so the draw is convex in water speed and a
// mph added on the nose costs more than the same mph taken off the tail gives back. The mean head
// component on that hairpin is zero. The real cost is 3.3% above still water. Only a sum finds it.
//
// The second half of this file is the wiring: until 2026-09-17 the Smart Plan selector chose the
// day's legs in flat calm and the model was then asked whether the day was safe, and the Pick Water
// budget refused days against a wind its own cost card had already counted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ampHours, ampHoursBand, ampHoursAlong, bearingDeg, worstWind, metresBetween,
         selectCandidates, forModel } from '../js/modules/plan-candidates.js';

// ── GEOMETRY, IN METRES, AT A LATITUDE THE APP ACTUALLY FISHES ───────────────────────────────────
const LAT = 34.0, LON0 = -81.0;
const mPerLon = 111320 * Math.cos((LAT * Math.PI) / 180);
const mPerLat = 110574;
const east = (m) => LON0 + m / mPerLon;
const north = (m) => LAT + m / mPerLat;

// Due east, 2 km, three vertices.
const STRAIGHT = [[east(0), LAT], [east(1000), LAT], [east(2000), LAT]];
// 2 km east, 50 m north, 2 km back west. Its chord runs due NORTH.
const HAIRPIN = [[east(0), LAT], [east(2000), LAT], [east(2000), north(50)], [east(0), north(50)]];
// Fifteen on the nose of anything heading east.
const FROM_EAST = { mph: 15, deg: 90 };

const lengthOf = (c) => c.slice(1).reduce((s, p, i) => s + metresBetween(c[i], p), 0);

test('a straight leg costs the same walked as it does resolved against its one bearing', () => {
  const walked = ampHoursAlong(STRAIGHT, 2.0, { wind: FROM_EAST });
  const chord = ampHoursBand(lengthOf(STRAIGHT), 2.0, 90, { wind: FROM_EAST });
  // Where the leg IS a straight line the two must agree, or the new path has changed the battery
  // model rather than the geometry it is applied to.
  assert.ok(Math.abs(walked.ah - chord.ah) / chord.ah < 0.002,
            `walked ${walked.ah} vs chord ${chord.ah}`);
  assert.equal(walked.headwindMph, 15);
  assert.equal(walked.segments, 2);
});

test('a leg that doubles back costs more than still water, and the chord says it costs nothing', () => {
  const walked = ampHoursAlong(HAIRPIN, 2.0, { wind: FROM_EAST });
  const calm = ampHoursAlong(HAIRPIN, 2.0, { wind: null });
  const chordDeg = bearingDeg(HAIRPIN[0], HAIRPIN[HAIRPIN.length - 1]);
  const chord = ampHoursBand(lengthOf(HAIRPIN), 2.0, chordDeg, { wind: FROM_EAST });

  // The chord runs due north between two arms that run due east and due west.
  assert.ok(chordDeg < 1 || chordDeg > 359, `chord bearing ${chordDeg}`);
  // THE DEFECT, STATED AS A NUMBER: resolving fifteen mph against that chord charges exactly the
  // still-water price, so the old code costed this leg as though the day were calm.
  assert.equal(Number(chord.ah.toFixed(6)), Number(calm.ah.toFixed(6)));
  // The sum does not.
  assert.ok(walked.ah > calm.ah, `walked ${walked.ah} vs calm ${calm.ah}`);
  // Convexity, sized. (2.45/2)^1.756 and (1.55/2)^1.756 average to 1.033 -- half the leg into the
  // 3% of the wind that is surface drift, half of it pushed, and the two do not cancel.
  const ratio = walked.ah / calm.ah;
  assert.ok(ratio > 1.02 && ratio < 1.05, `ratio ${ratio}`);
});

test('and the mean head component on that leg is zero, which is why the cost is a sum', () => {
  const walked = ampHoursAlong(HAIRPIN, 2.0, { wind: FROM_EAST });
  // Half on the nose, half on the tail, equal lengths. An estimator that averaged the head
  // component and then priced once would have produced the still-water answer the chord produced.
  assert.equal(walked.headwindMph, 0);
  assert.ok(walked.ah > ampHoursAlong(HAIRPIN, 2.0, { wind: null }).ah);
});

test('walking the line the other way is the other direction, wind and all', () => {
  const out = ampHoursAlong(STRAIGHT, 2.0, { wind: FROM_EAST });
  const back = ampHoursAlong([...STRAIGHT].reverse(), 2.0, { wind: FROM_EAST });
  assert.equal(out.headwindMph, 15);
  assert.equal(back.headwindMph, -15);
  assert.ok(back.ah < out.ah, 'the way home on a push is cheaper than the way out on the nose');
  // Same water, same length, whichever way it is walked.
  assert.equal(out.lengthM, back.lengthM);
});

test('a current that follows the channel is handed over resolved, not measured off a bending line', () => {
  const up = ampHoursAlong(STRAIGHT, 2.0, { alongCurrentMph: 1.0 });
  const down = ampHoursAlong(STRAIGHT, 2.0, { alongCurrentMph: -1.0 });
  const still = ampHours(lengthOf(STRAIGHT), 2.0);
  assert.ok(up.ah > still, 'upstream costs more than still water');
  // NOT FLOORED AT ZERO. A push is real and charging nothing for it would make every river day
  // cost more than it does -- the same dishonesty pointing the other way.
  assert.ok(down.ah < still, 'downstream costs less than still water');
  assert.equal(up.currentMph, 1);
  assert.equal(down.currentMph, -1);
});

test('a flow cannot arrive twice, because two conventions for one angle is how this went wrong before', () => {
  assert.throws(
    () => ampHoursBand(1000, 2.0, 90, { alongCurrentMph: 1, currentMph: 1, currentDeg: 90 }),
    /never both/);
  // Either one alone is fine.
  assert.ok(ampHoursBand(1000, 2.0, 90, { alongCurrentMph: 1 }).ah > 0);
  assert.ok(ampHoursBand(1000, 2.0, 90, { currentMph: 1, currentDeg: 90 }).ah > 0);
});

test('a repeated vertex has no bearing, so it is skipped rather than costed at one', () => {
  const doubled = [STRAIGHT[0], STRAIGHT[0], STRAIGHT[1], STRAIGHT[2]];
  const plain = ampHoursAlong(STRAIGHT, 2.0, { wind: FROM_EAST });
  const dup = ampHoursAlong(doubled, 2.0, { wind: FROM_EAST });
  assert.equal(dup.segments, plain.segments);
  assert.equal(dup.ah, plain.ah);
  // And a line with nothing to walk costs nothing rather than throwing on atan2(0, 0).
  assert.equal(ampHoursAlong([[0, 0]], 2.0, { wind: FROM_EAST }).ah, 0);
  assert.equal(ampHoursAlong(null, 2.0, { wind: FROM_EAST }).segments, 0);
});

// ── AND THE SELECTOR THAT CHOOSES THE DAY NOW SEES THE SAME FORECAST ────────────────────────────
//
// Fixture: one straight lane running due east, 2.4 km, with the ramp off its western end. The same
// shape plan-weights.test.js uses, for the same reason -- the dedupe and the proximity discount are
// both controlled for, so the only thing that can move a number here is the wind.
const lane = () => {
  const coords = Array.from({ length: 41 }, (_, k) => [-80.720 + k * 0.0006, 34.38]);
  return { type: 'Feature', geometry: { type: 'LineString', coordinates: coords },
    properties: { depth_ft: 20, length_m: 2200, routable: true, relief: 'flat',
      near: Array.from({ length: 6 }, (_, k) => ({ s: 200 + k * 300, t: 'timber', d: 25 })) } };
};
const RUNS = [lane()];
const BASE = { ramp: [-80.73, 34.38], slug: 'w', fishDepthFt: [0, 99], holding: 'bottom',
               usableAh: 999, windowMin: 9999 };

test('a leg into the wind costs more than the same leg in calm', () => {
  const calm = selectCandidates(RUNS, BASE)[0];
  const blown = selectCandidates(RUNS, { ...BASE, wind: { mph: 15, deg: 90 } })[0];
  assert.equal(calm.lengthM, blown.lengthM, 'the same water, so the difference is the air');
  assert.ok(blown.batteryAh > calm.batteryAh, `${blown.batteryAh} vs ${calm.batteryAh}`);
  assert.equal(calm.headwindMph, null, 'no forecast was supplied, so nothing is claimed about the wind');
  assert.equal(blown.headwindMph, 15);
});

test('and it costs the same whichever way the contour happens to be drawn', () => {
  // The direction this leg gets fished is not decided here -- orientLegs and the model do that
  // later -- so the gate prices the dearer of the two and a wind from 090 and a wind from 270 are
  // the same day on an east-west lane. If this ever stops being true, a leg's battery price has
  // started depending on which end the pipeline drew first.
  const from090 = selectCandidates(RUNS, { ...BASE, wind: { mph: 15, deg: 90 } })[0];
  const from270 = selectCandidates(RUNS, { ...BASE, wind: { mph: 15, deg: 270 } })[0];
  assert.equal(from090.batteryAh, from270.batteryAh);
  assert.equal(from090.headwindMph, 15);
  assert.equal(from270.headwindMph, 15);
});

test('the battery gate refuses on a wind it could not see before', () => {
  // 11.22 Ah in calm, 12.39 Ah into fifteen. A day with 11.5 usable fits one and not the other, and
  // until now the selector offered it either way. Ryan on the one thing allowed to be rigid: "if
  // they are going to run out of battery because of choice they shouldn't be able to make that
  // choice."
  const roomy = selectCandidates(RUNS, { ...BASE, usableAh: 11.5 });
  const blown = selectCandidates(RUNS, { ...BASE, usableAh: 11.5, wind: { mph: 15, deg: 90 } });
  assert.equal(roomy.length, 1);
  assert.equal(blown.length, 0);
  assert.equal(blown.selection.rejected.battery, 1);
});

test('the day is costed against the hour that blows hardest, gusts included', () => {
  // A day calm at six and blowing at eleven has to be costed for eleven, which is the whole reason
  // windByHour replaced a daily maximum. Same reduction dayCost() makes, in one place.
  const hourly = selectCandidates(RUNS, { ...BASE,
    windByHour: [{ hour: 6, mph: 3, deg: 90 }, { hour: 11, mph: 9, gustMph: 15, deg: 90 }] })[0];
  const worst = selectCandidates(RUNS, { ...BASE, wind: { mph: 15, deg: 90 } })[0];
  assert.equal(hourly.batteryAh, worst.batteryAh);
  assert.equal(worstWind([{ hour: 6, mph: 4, deg: 90 },
                          { hour: 11, mph: 9, gustMph: 16, deg: 200 }]).mph, 16);
  // No forecast is not a calm day -- it is a leg priced in calm and a caller that says so.
  const none = selectCandidates(RUNS, { ...BASE, windByHour: null })[0];
  assert.equal(none.headwindMph, null);
});

test('the model is told what is on the nose, per leg', () => {
  // The safety section has been asked to rule on wind since it was written, off one day-level
  // number with no idea which legs faced into it.
  const blown = selectCandidates(RUNS, { ...BASE, wind: { mph: 15, deg: 90 } })[0];
  assert.equal(forModel(blown).headwindMph, 15);
  // A FORECAST CROSSWIND IS A ZERO WORTH SENDING. The leg was costed, the wind was across it, and
  // "0 on the nose" is a fact about the day.
  const across = selectCandidates(RUNS, { ...BASE, wind: { mph: 15, deg: 0 } })[0];
  assert.equal(across.headwindMph, 0);
  assert.equal(forModel(across).headwindMph, 0);
  // NO FORECAST IS NOT A CALM DAY. Nothing is sent, so nothing reads as calm.
  assert.equal(selectCandidates(RUNS, BASE)[0].headwindMph, null);
  assert.equal(forModel(selectCandidates(RUNS, BASE)[0]).headwindMph, undefined);
});

// ── THE WIRING, BECAUSE A COST MODEL NOBODY CALLS IS WORTH EXACTLY NOTHING ──────────────────────
const V2 = readFileSync(new URL('../js/modules/smart-plan-v2.js', import.meta.url), 'utf8');
const V2_WIRING = readFileSync(new URL('../js/modules/smart-plan-v2-wiring.js', import.meta.url), 'utf8');
const PW_UI = readFileSync(new URL('../js/modules/plan-water-ui.js', import.meta.url), 'utf8');
const PW = readFileSync(new URL('../js/modules/plan-from-water.js', import.meta.url), 'utf8');

test('both planners hand the same forecast to the thing that prices the day', () => {
  // Smart Plan: browser -> buildSmartPlanV2 -> selectCandidates.
  assert.ok(V2_WIRING.includes('windByHour: forecast ? forecast.windByHour : null'),
            'the wiring takes windByHour off the forecast');
  assert.ok(V2.includes('windByHour: o.windByHour'), 'and buildSmartPlanV2 forwards it');
  // Pick Water: the cost card has costed against it for months; the refusal did not.
  assert.ok(PW_UI.includes('windByHour: T.windByHour,'), 'planFromWater is given the same hours');
  // Reduced ONCE on this path, then handed to the refusal and to every leg. Reducing it privately
  // inside dayCost() is how the budget and the legs came to disagree in the first place.
  assert.ok(PW.includes('const wind = o.wind || worstWind(o.windByHour);'),
            'planFromWater reduces the forecast itself');
  assert.ok(/dayCost\(picked, \{[\s\S]{0,200}\bwind\b/.test(PW), 'the refusal is costed against it');
  assert.ok(PW.includes('legFrom(p, i, o.ramp, o.slug, wind)'), 'and so is every leg');
});

test('and a picked piece is priced the same way a chosen one is', () => {
  // The two planners build a leg through different code -- Pick Water deliberately does not call
  // selectCandidates(), see the header of plan-from-water.js -- so the only thing keeping their
  // battery prices in step is that both walk the geometry through the same function.
  assert.ok(PW.includes("import { ampHoursAlong"), 'Pick Water walks the leg, it does not chord it');
  // Comments stripped first: this file explains what the old still-water call WAS, and a claim
  // about what the code does must not be satisfied or broken by prose about what it used to do.
  const code = PW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/\bampHours\(/.test(code), 'and nothing on that path is priced in flat calm any more');
  assert.ok(PW.includes('headwindMph: l.headwindMph ?? undefined'),
            'and the model is told the same field it gets from Smart Plan');
});
