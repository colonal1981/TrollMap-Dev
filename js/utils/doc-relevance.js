/**
 * doc-relevance.js — the off-lake gate, moved off the Worker.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * WHY IT MOVED. This Worker is on the Cloudflare FREE plan, where CPU is capped at 10 ms per
 * request and, unlike the paid plan's 30 s, THAT NUMBER IS NOT CONFIGURABLE. `save-normalized`
 * was parsing up to 1.8 MB of JSON, scanning the first 3,000 characters of every document,
 * rebuilding the array and re-serialising it — all inside that 10 ms. From wrangler tail on
 * 2026-08-16: "POST /research/save-normalized - Exceeded CPU Limit".
 *
 * None of that work needs a Worker. The browser already holds the documents, has no CPU
 * ceiling, and is where they were fetched. What the Worker has that the browser does not is
 * the R2 credential — so it should write bytes and nothing else, which is what it does now:
 * the client sends the finished array and the Worker streams the request body straight into
 * the bucket without parsing it.
 *
 * The logic below is a port of the Worker's gate, unchanged in behaviour and now testable —
 * it could never be exercised where it was, because it lived behind an HTTP handler.
 */

/**
 * Sources whose documents are about the water they are about, name test or no name test.
 *
 * THIS LIST WAS HAND-WRITTEN AND NEVER CHECKED AGAINST THE DOMAINS THE PIPELINE ACTUALLY READS.
 * Counted 2026-09-01 across Worker/ and js/: `tn.gov` appears 13 times, `georgiawildlife` 14,
 * `usace.army.mil` 7, `deq.nc.gov` 6, `gadnr` 34 -- and none of them were here. Meanwhile
 * `tw.gov` was, which is Taiwan; it is a typo for Tennessee that has been matching nothing.
 * `dnr.nc.gov` is here and appears nowhere else in the codebase -- North Carolina's agencies are
 * ncwildlife.org and deq.nc.gov -- so it was a guess. It stays, because it costs nothing.
 *
 * Counted again 2026-09-02 against the 64-water run: the gate dropped 124 documents and 77 of
 * them were distinct. Eleven sat on a .gov, .edu or authority domain, and THREE of those were
 * about the water they were refused for:
 *
 *   ncpaws.org -- "Macon County - 2026 MASTER TROUT STOCKING LIST", dropped from NANTAHALA LAKE,
 *   which is a stocked trout water in Macon County. This is NC WRC's own reporting system, read
 *   in four other places here (build_nc_species_by_lake.py, Worker/registry.js and two tests),
 *   and the source every NC profile's stocking plan is built from. Added below.
 *
 *   triadncwater.gov and congareeriverkeeper.org -- see offLakeReason(). Those two are NOT fixed
 *   by adding a domain, and the first draft of this comment argued they should be left alone
 *   because the pipeline reads them nowhere else. That is a fact about this codebase and not
 *   about the documents; both pages turned out to name their water and to carry real fishing
 *   information. They are fixed by asking the name rule of the body, which is what a domain list
 *   cannot scale to do -- there is no finite list of the sites that write about these lakes.
 *
 * The other 74 were refused correctly, and the list is worth reading once: a Princeton
 * autocomplete word list, an MIT word list, a New York power-line filing, a Texas coastal-zone
 * program, a plant-ecology paper, an archives finding aid, and forty-odd fishing reports that
 * name a DIFFERENT lake in their own title -- Hickory dropped from twelve other waters, Lake Fork
 * in Texas from fourteen.
 *
 * What it cost: the run of 2026-09-01 rejected
 * "Fishing - US Army Corps of Engineers - Mobile District" at
 * sam.usace.army.mil/.../Lake-Sidney-Lanier/Fishing -- the federal agency that OPERATES the
 * reservoir, refused for a document about the lake it runs. Georgia is the sharper case: every
 * agency lake page behind registry/agency_lake_facts.json is on georgiawildlife.com, and the
 * gate did not know the domain.
 */
const OFFICIAL_SOURCE = /eregulations\.com|dnr\.sc\.gov|dnr\.nc\.gov|deq\.nc\.gov|epd\.georgia|epa\.gov|waterqualitydata|grokipedia|santeecooper|ncwildlife|ncpaws|georgiawildlife|gadnr|scdnr|tn\.gov|tva\.gov|usace\.army\.mil/i;

/** "Lake Marion, SC" -> {baseName: "Marion", state: "SC"} */
export function lakeTerms(lakeName) {
  const name = String(lakeName || '');
  const baseName = name
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/^Lake\s+/i, '')
    .replace(/,\s*(SC|NC|GA|TN)(\/(?:SC|NC|GA|TN))*\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const m = name.match(/,?\s*\b(SC|NC|GA|TN)\b/i);
  return { baseName, state: m ? m[1].toUpperCase() : '' };
}

/**
 * THE FALLBACK, AND ONLY THE FALLBACK: a name AND a state signal, because "Marion Lake, MN"
 * passes a name check on its own. It is a loose substring test on the whole blob, which is why
 * it needs the state to lean on -- the strict name rule below does not, and answers first.
 * Official sources bypass both: an SCDNR or EPA document is about the water it is about, and
 * dropping one for failing a substring test costs more than the occasional off-lake page.
 */
/** Waterbody nouns, so a one-word name has to name a WATER and not an adjective. */
const WATER_NOUN = ['lake', 'reservoir', 'pond', 'dam', 'impoundment'];

const flat = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Does the title or the URL name this water?
 *
 * A PAGE TITLED FOR A LAKE IS ABOUT THAT LAKE, and the state test below cannot know it. That test
 * exists to keep "Marion Lake, MN" out of Lake Marion, SC, and it works by demanding a state
 * signal in the same blob as the name -- title, url and the first 3,000 characters run together.
 * A fishing report about Hyco Lake often never writes "NC" or "North Carolina" anywhere in it.
 *
 * Measured 2026-09-01 across the seventeen-lake cold batch: the gate dropped 48 documents and 22
 * of them named the lake in their own title or URL. "Hyco Lake Fishing Reports". "Mountain Island
 * Lake Fishing". All three Rhodhiss pages. "Stripers backed up at Tuckertown dam". Every W. Kerr
 * Scott page. That is the prose the fisheries doc ranking calls the best source there is, refused
 * for not repeating the state. Hyco kept four documents and lost its two best.
 *
 * TWO RULES, AND THE SECOND IS WHY THIS IS NOT A SUBSTRING TEST. A multi-word base name is
 * distinctive by itself -- "mountain island", "w kerr scott", "lookout shoals". A ONE-WORD base is
 * not: White Lake bases to "white", which matches "white bass" and "white perch" in any title. So
 * a single word must arrive beside a waterbody noun -- "hyco lake", "lake rhodhiss", "randleman
 * reservoir", "tuckertown dam". That is how a water's name is written and not how a fish's colour
 * is.
 *
 * Aliases go through the same two rules, which is what reaches "Lake Russell fishing report" for
 * Richard B Russell Lake and "Moss Lake fishing reports" for John H. Moss Lake.
 *
 * What still fails, correctly, on the same 48: Cleveland Metroparks in Ohio, a Maryland report,
 * Smith Mountain Lake in Virginia, Jackson Hole, Texas Parks and Wildlife, Oregon DFW, the
 * Cambridge Dictionary's definition of "lake", and the county recreation pages that mention no
 * water at all.
 */
const OUR_STATES = ['sc', 'nc', 'ga', 'tn'];

/**
 * The states this app does not cover, spelled out. Two-letter codes are deliberately NOT here:
 * `in`, `or`, `me`, `de`, `ok`, `hi`, `la`, `pa` and `co` are all ordinary words and would refuse
 * half the good pages. A `state.xx.us` domain is the one abbreviation that cannot be a word.
 */
const OTHER_STATE = new RegExp('\\b(' + [
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware',
  'florida', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana',
  'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri',
  'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey', 'new mexico', 'new york',
  'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south dakota',
  'texas', 'utah', 'vermont', 'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming',
].join('|') + ')\\b');

/** A page that names another state in its own title or URL is not this lake's page. */
function claimedByAnotherState(hay, state) {
  if (OTHER_STATE.test(hay)) return true;
  const m = /\bstate ([a-z]{2}) us\b/.exec(hay);
  return !!m && m[1] !== String(state || '').toLowerCase() && !OUR_STATES.includes(m[1]);
}

function namesTheWater(hay, names) {
  if (!hay) return false;
  for (const raw of names) {
    const full = flat(lakeTerms(raw).baseName || raw);
    const base = full.replace(/^lake /, '').replace(/ (lake|reservoir)$/, '').trim();
    if (base.length < 4) continue;
    if (base.includes(' ') && hay.includes(base)) return true;
    for (const w of WATER_NOUN) {
      if (hay.includes(`${base} ${w}`) || hay.includes(`${w} ${base}`)) return true;
    }
  }
  return false;
}

/**
 * Why this document was refused, or null when it was kept. `isOnLakeDoc` is this, read as a
 * yes/no; the reason exists because a count of six drops never said whether the gate was RIGHT,
 * and answering that took a session of re-reading pages by hand.
 *
 *   official_source     the domain is an agency or operator this pipeline already reads
 *   other_state         the title or URL claims a state this app does not cover
 *   no_name             nothing in the title, the URL or the first 3,000 characters names it
 *   named_no_state      the water is named, loosely, but the page never repeats its state
 *
 * THE RULE THAT NAMES THE WATER IS NOW ASKED OF THE BODY AS WELL AS THE TITLE, and that is the
 * change of 2026-09-02. The title half was added on 2026-09-01 for pages like "Hyco Lake Fishing
 * Reports" that never write "NC", and the same reasoning stops one line short of the body:
 *
 *   RANDLEMAN LAKE (Randolph Co, NC) -- "Reservoir Recreation" on triadncwater.gov, the water
 *   authority that BUILT and operates the lake. The page writes "current conditions at Randleman
 *   Lake" and "Randleman Regional Reservoir", lists the launches by what may run on them --
 *   gasoline, electric only, paddle -- and prices the fishing pier. It never says North Carolina,
 *   because a local authority writing for local people does not.
 *
 *   PARR SHOALS RESERVOIR (Fairfield Co, SC) -- Congaree Riverkeeper's lower Broad River page.
 *   It opens by naming Parr Shoals Reservoir as the top of its own 22-mile reach, lists the
 *   species in that water, gives the mean flow at 5,316 ft^3/s, names the ONE public landing
 *   below Parr Reservoir, and flags the low dissolved oxygen and copper impairment.
 *
 * Both were refused by the STATE half and neither by the name half -- measured, not guessed, by
 * running this function on them. Ryan, on the two of them: "if there is information that is
 * available on the open web that is better or equal to what we have why would we throw that
 * aside?"
 *
 * The other-state check still guards both bypasses and still reads the TITLE AND URL ONLY. It
 * must not read the body: "Texas rig" and "Carolina rig" are bass fishing, and a page about Lake
 * Wateree that mentions one would refuse itself.
 */
export function offLakeReason(doc, lakeName, altNames = []) {
  const { baseName, state } = lakeTerms(lakeName);
  const url = String(doc?.url || '').toLowerCase();
  if (OFFICIAL_SOURCE.test(url)) return null;

  const every = [lakeName, ...(Array.isArray(altNames) ? altNames : [])].filter(Boolean);
  const titleHay = flat(`${doc?.title || ''} ${doc?.url || ''}`);
  // THE ONE CASE THE NAME RULE CANNOT HAVE. `test/doc-relevance.test.js` has asserted since it
  // was written that "Marion Lake fisheries survey" on dnr.state.mn.us must not pass for Lake
  // Marion, SC -- and it names the lake in its title, so the rule would have taken it. The test
  // caught it on the first run, which is the whole reason that test exists.
  const foreign = claimedByAnotherState(titleHay, state);

  const body = String(doc?.fullText || doc?.text || '').slice(0, 3000);
  if (!foreign && (namesTheWater(titleHay, every) || namesTheWater(flat(body), every))) return null;

  const combined = `${String(doc?.title || '').toLowerCase()} ${url} ${body.toLowerCase()}`;

  // EVERY NAME THE WATER HAS, because discovery was already told all of them and this was not.
  //
  // lake-research-engine.js builds `names` for /research/discover out of the registry row --
  // `[name, displayName, ...legacyDisplayNames]` -- under a comment naming the exact problem:
  // "SCDNR says 'Lake Thurmond' where the registry says 'J. Strom Thurmond Reservoir', TWRA says
  // 'Ft. Loudoun Reservoir' where it says 'Fort Loudoun Lake'." Discovery then found documents
  // under those names and handed them here, where the gate knew only the display name and threw
  // them away.
  //
  // Measured 2026-09-01 on two runs of the batch: Lake Sidney Lanier (Hall Co, GA) fetched nine
  // documents and this gate rejected SIX of them, both times. Its base name is "Sidney Lanier"
  // and every document in the world writes "Lake Lanier" -- which the registry has known all
  // along, in legacy_display_names. Counted across the 64 research waters: 40 carry a legacy
  // name whose base differs from the one this looks for, and the clean misses are the ones
  // nobody spells the registry's way -- Clarks Hill for Thurmond, Jordan Lake for B. Everett
  // Jordan Lake, Moss Lake for John H. Moss Lake, and every Lake-versus-Reservoir pair in
  // Tennessee, where "Norris Reservoir" does not contain "Norris Lake".
  //
  // Still both halves: a name AND a state. Widening the names does not widen the state test,
  // which is what keeps "Marion Lake, MN" out.
  const names = [String(lakeName || ''), baseName];
  for (const alt of Array.isArray(altNames) ? altNames : []) {
    if (!alt) continue;
    names.push(String(alt), lakeTerms(alt).baseName);
  }
  const hasLakeName = names
    .map((t) => String(t || '').toLowerCase().trim())
    .filter((t) => t.length >= 4)
    .some((t) => combined.includes(t));
  if (!hasLakeName) return foreign ? 'other_state' : 'no_name';
  if (!state) return null;

  const s = state.toLowerCase();
  const hasState = [` ${s} `, `(${s})`, `${s} lake`, 'south carolina', 'north carolina', 'georgia',
    'tennessee', 'santee', 'scdnr', 'ncwrc', 'gadnr'].some((t) => combined.includes(t));
  return hasState ? null : (foreign ? 'other_state' : 'named_no_state');
}

/** Does this document plausibly concern this lake? `offLakeReason` with the reason thrown away. */
export function isOnLakeDoc(doc, lakeName, altNames = []) {
  return offLakeReason(doc, lakeName, altNames) === null;
}

/** The finished array the Worker will store verbatim. */
export function prepareNormalizedDocuments(documents, lakeName, agentTags = [], nowIso = null, altNames = []) {
  const all = Array.isArray(documents) ? documents : [];
  const stamp = nowIso || new Date().toISOString();
  // AGENT TAGS ARE POSITIONAL AGAINST THE ORIGINAL LIST, so the original index has to be
  // carried across the filter. The Worker's version mapped over the FILTERED array with its
  // own index -- drop document 1 and every tag after it shifts down one, so a document
  // discovered by `identity` gets filed as `habitat`. Faithfully ported, then caught by the
  // first test that had ever been able to run this code, which is the whole argument for
  // moving it out of an HTTP handler.
  const judged = all.map((doc, i) => ({ doc, i, why: offLakeReason(doc, lakeName, altNames) }));
  const kept = judged.filter(({ why }) => why === null);
  return {
    documents: kept.map(({ doc, i }) => ({
      ...doc,
      agentTags: doc.agentTags || agentTags[i] || [],
      discoveredBy: doc.discoveredBy || (agentTags[i] ? agentTags[i][0] : 'unknown'),
      fetchedAt: doc.fetchedAt || stamp,
    })),
    // WHAT WAS REFUSED AND WHY, SAID HERE RATHER THAN WORKED OUT AGAIN BY THE CALLER.
    // research_lakes.py rebuilt this list by differencing URL sets, which is a second copy of a
    // question this function has already answered -- and it could only ever produce a title, so
    // "is the gate right" had to be settled by opening the pages by hand. The reason turns that
    // into a read: `named_no_state` is the one worth arguing with, `no_name` almost never is.
    refused: judged.filter(({ why }) => why !== null)
      .map(({ doc, why }) => ({ title: doc?.title || null, url: doc?.url || null, why })),
    rejected: all.length - kept.length,
    total: all.length,
  };
}
