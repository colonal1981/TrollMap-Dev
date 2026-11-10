/**
 * my-lakes.js -- Ryan's lakes and the ramp he uses on each, for the "Which lake?" card (change request 85).
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Ryan, 2026-11-09, planning Wednesday 11/11: "the app should be able to check the forecast for the main lakes near me
 * and tell me which one is the best for the forecast". His lakes and ramps, in his words:
 *
 *   Murray       "murray at hilton is my normal"
 *   Wateree      the Shaw rec area beside Clearwater Cove (11/8); the app's ramp there is Clearwater Cove
 *   Marion       "for striper on marion i don't of know of any other areas besides wyboo creek that gets me to good
 *                striper water in the fall and winter... now for the spring it will be the upper end of the lake and
 *                the river", and of the spring ramp: "packs landing is the closest and easiest... i can also launch from
 *                Lowfalls and get into the river but its a bit further from the house than packs"
 *   Moultrie     "for moultrie probably short stay evertime... i can catch bass, cats and stripers from there"
 *   Monticello   "whichever one is more protected on that day of the 2 ramps... just know that there i am either
 *                targetting small or largemouth bass as there isn't striper in that lake"
 *   Bates        "Bates is the fall back if it is too windy on the main lakes... it is very protected and small so there
 *                isn't waves to worry about"
 *
 * THE NAMES ARE THE APP'S OWN, read off the planner's dropdowns on trollmap-dev on 2026-11-09 (Lake and Ramp), so a tap
 * on the card can put them back into those dropdowns exactly. The positions are the ones those options carry.
 *
 * THE MARION MONTHS ARE MINE, put to him with the design: Rowland (his Wyboo Creek ramp) October through February,
 * Pack's Landing from March. The striper closure is not written here -- the card asks checkPlanLegality(), the same
 * check that refuses a plan, so a closed fish on a closed water drops off the card the way it is refused a plan. His
 * instruction, 11/9: "just use the same logic that prevents a plan being made during a closure".
 */

const MY_LAKES = [
  { lake: 'Lake Murray, SC', ramps: [{ name: 'Hilton Recreation Area', at: [-81.328882, 34.094287] }] },
  { lake: 'Lake Wateree, SC', ramps: [{ name: 'Clearwater Cove', at: [-80.728814, 34.379271] }] },
  { lake: 'Lake Marion, SC', seasons: [
    // Fall and winter: Wyboo Creek, from Rowland.
    { months: [10, 11, 12, 1, 2], ramps: [{ name: 'Rowland Subdivision', at: [-80.224262, 33.546151] }] },
    // Spring onward: the upper end and the river, from Pack's; Low Falls is his other way in.
    { months: [3, 4, 5, 6, 7, 8, 9], ramps: [{ name: "Pack's Landing", at: [-80.51505, 33.659378] }],
      other: 'Low Falls Landing' },
  ] },
  { lake: 'Lake Moultrie, SC', ramps: [{ name: 'Short Stay Boat Ramp', at: [-79.9887162, 33.2545187] }] },
  { lake: 'Lake Monticello, SC', species: ['Largemouth Bass'], pick: 'sheltered', ramps: [
    { name: 'Monticello Boat Ramp', at: [-81.285632, 34.327565] },
    { name: '99 Boat Ramp', at: [-81.317874, 34.376271] },
  ] },
  { lake: 'Bates Old River (Richland Co, SC)', fallback: true,
    ramps: [{ name: 'Dirt road kayak launch', at: [-80.63566, 33.78543] }] },
];

/**
 * The lakes for these fish on this date, each with the ramps to weigh and the fish it is for.
 *
 * A lake that names its fish (Monticello: bass) is only offered for those; every other lake is offered for whatever
 * he ticked. The ramps are the season's on a lake that changes ramp by season.
 *
 * @param {string[]} species   the ticked fish
 * @param {string} dateStr     YYYY-MM-DD, his local date
 * @returns {{lake:string, ramps:{name:string, at:number[]}[], species:string[], pick:string, fallback:boolean,
 *            other:?string}[]}
 */
export function lakesFor(species, dateStr) {
  const month = Number(String(dateStr || '').slice(5, 7));
  const out = [];
  for (const L of MY_LAKES) {
    const fish = (species || []).filter((s) => !L.species || L.species.includes(s));
    if (!fish.length) continue;
    const season = L.seasons ? L.seasons.find((s) => s.months.includes(month)) : null;
    const ramps = season ? season.ramps : L.ramps;
    if (!ramps || !ramps.length) continue;
    out.push({ lake: L.lake, ramps, species: fish, pick: L.pick || 'first', fallback: !!L.fallback,
               other: (season && season.other) || null });
  }
  return out;
}
