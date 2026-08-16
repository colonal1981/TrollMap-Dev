/**
 * operators.js — the three utility operators that publish HTML tables instead of JSON.
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * Duke and TVA return JSON and USACE has a REST API. These three render server-side, so the
 * numbers live in the markup. Ryan saved the page source on 2026-08-16 because neither the
 * sandbox nor the device VM can reach these hosts, and TEXT WAS NOT ENOUGH -- Southern
 * Company's empty Gen and Rain cells are `&nbsp;` in the markup and vanish in a tag strip,
 * leaving "Allatoona 0 840.75 840" indistinguishable from a row whose first number is the
 * elevation. Every parser below is written against the real saved source.
 *
 *   Cube Carolinas    ww4.cubecarolinas.com/lake/levels?orgID=3   4 lakes, 3 shipped
 *   Southern Company  lakes.southernco.com/default.aspx          26 rows, 21 with readings
 *   Brookfield        safewaters.com/facility/<slug>/             per facility
 */

// AN EMPTY CELL IS NOT A ZERO. Number('') is 0 and Number.isFinite(0) is true, so the first
// version of this turned every &nbsp; Rain cell into a measured "0 inches of rain" and every
// blank Current Elevation into a lake sitting at sea level. Southern Company's table is mostly
// empty cells; that one coercion would have put a hard fact on all of them.
const num = (v) => {
  const s = String(v == null ? '' : v).replace(/,/g, '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const text = (h) => String(h || '').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;?/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();

const rowsOf = (tableHtml) => [...String(tableHtml || '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]);
const cellsOf = (rowHtml) => [...String(rowHtml || '').matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => m[1]);
const tableById = (html, id) => {
  const re = new RegExp(`<table[^>]*id="${id}"[^>]*>([\\s\\S]*?)</table>`, 'i');
  const m = re.exec(String(html || ''));
  return m ? m[1] : null;
};

/* ── Cube Carolinas ──────────────────────────────────────────────────────────────────────────
 *
 * <table id="GridView1">, columns: Lake | Elevation | FT Below Full Pond | Fluctuation Forecast.
 *
 * IT PUBLISHES THE DRAWDOWN AS ITS OWN COLUMN, which is the number chartDatum() computes for
 * everyone else, so full pond falls out of the two rather than needing a reference.
 *
 * The forecast is an IMAGE, not text: fluctuate_R.gif / _F.gif / _S.gif. The page's own legend
 * spells out R=RISE, F=FALL, S=SAME, so this is reading the page's key, not guessing at a
 * filename.
 */
const CUBE_FORECAST = { R: 'rising', F: 'falling', S: 'steady' };

export function parseCubeLevels(html) {
  const t = tableById(html, 'GridView1');
  if (!t) return { lakes: [], observedAt: null };
  const lakes = [];
  for (const row of rowsOf(t)) {
    const c = cellsOf(row);
    if (c.length < 4) continue;
    const name = text(c[0]);
    const elevationFt = num(text(c[1]));
    const belowFullPondFt = num(text(c[2]));
    if (!name || elevationFt == null || belowFullPondFt == null) continue;   // skips the header
    const img = /fluctuate_([RFS])\.gif/i.exec(c[3]);
    lakes.push({
      name,
      elevationFt,
      belowFullPondFt,
      // Stated by the operator as two numbers; their sum is the full pond it is measuring from.
      fullPondFt: Math.round((elevationFt + belowFullPondFt) * 100) / 100,
      forecast: img ? CUBE_FORECAST[img[1].toUpperCase()] : null,
    });
  }
  const stamp = /id="FormView1_timestmpLabel"[^>]*>([^<]+)</i.exec(String(html || ''));
  return { lakes, observedAt: stamp ? stamp[1].trim() : null };
}

/* ── Southern Company / Georgia Power ────────────────────────────────────────────────────────
 *
 * <table id="MainContent_LakeGrid">, columns: Lake | Gen | Rain | Current Elevation | Full
 * Elevation. Twenty-six rows including spacer rows whose every cell is &nbsp;, and five real
 * lakes with no reading at all (Athens, Bold Springs, Bull Sluice, Pine Mountain, Yates).
 *
 * A row with a name and no current elevation is NOT dropped: "the operator publishes this lake
 * and is not reporting a level today" is a different answer from "this lake is not on the
 * page", and only one of them means look somewhere else.
 */
export function parseSouthernCoLevels(html) {
  const t = tableById(html, 'MainContent_LakeGrid');
  if (!t) return { lakes: [], readingsFor: null, lastUpdated: null };
  const lakes = [];
  for (const row of rowsOf(t)) {
    const c = cellsOf(row);
    if (c.length < 5) continue;
    const name = text(c[0]);
    if (!name || /^lake$/i.test(name)) continue;            // spacer rows and the header
    lakes.push({
      name,
      generating: text(c[1]) || null,
      rainIn: num(text(c[2])),
      currentFt: num(text(c[3])),
      fullFt: num(text(c[4])),
      reporting: num(text(c[3])) != null,
    });
  }
  const label = /id="MainContent_LastUpdatedLabel"[^>]*>([\s\S]*?)<\/span>/i.exec(String(html || ''));
  const lab = label ? text(label[1]) : '';
  return {
    lakes,
    readingsFor: (/Readings for:\s*([\d/]+)/i.exec(lab) || [])[1] || null,
    lastUpdated: (/Last updated:\s*(.+)$/i.exec(lab) || [])[1] || null,
  };
}

/* ── Brookfield / Tapoco ─────────────────────────────────────────────────────────────────────
 *
 * safewaters.com/facility/<slug>/. Each reading is
 *
 *     <div class="facility-update-level-item"><h5>VALUE UNIT as of TIMESTAMP</h5><p>LABEL</p></div>
 *
 * EXCEPT THE TWO THAT MATTER, WHICH CARRY NO LABEL AT ALL. Santeetlah, 2026-08-15:
 *
 *     <h5>1939.61 ft as of 2026-08-15 08:50:40 PM (EDT)</h5>     (no <p>)
 *     <h5>-1.30 ft as of 2026-08-15 08:49:50 PM (EDT)</h5>       (no <p>)
 *
 * One is the absolute reservoir elevation and one is feet below full pond, and the page never
 * says which. Magnitude is the only discriminator available: a full pond is hundreds or
 * thousands of feet above sea level and a drawdown is single digits. The cut is at 100 ft --
 * no Brookfield facility sits within 100 ft of sea level and no drawdown approaches it.
 *
 * AND THE PAIR CHECKS ITSELF: 1939.61 + 1.30 = 1940.91 against the published full pond of
 * 1,940.9. That sum is returned as `fullPondFt`, so a mis-assignment shows up as a full pond
 * that is obviously wrong rather than as a plausible level.
 */
export function parseBrookfieldFacility(html) {
  const flat = String(html || '').replace(/\s+/g, ' ');
  const facility = text((/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(flat) || [])[1] || '') || null;
  const items = [...flat.matchAll(
    /<div class="facility-update-level-item">\s*<h5>\s*(-?[\d.,]+)\s*([A-Za-z]+)\s+as of\s+([^<]+?)\s*<\/h5>\s*(?:<p>([\s\S]*?)<\/p>)?/gi
  )].map((m) => ({
    value: num(m[1]), unit: (m[2] || '').toLowerCase(), at: m[3].trim(), label: m[4] ? text(m[4]) : null,
  }));

  const discharges = items.filter((i) => i.unit === 'cfs')
    .map((i) => ({ cfs: i.value, into: i.label, at: i.at }));
  const feet = items.filter((i) => i.unit === 'ft');
  const absolute = feet.find((i) => i.value != null && Math.abs(i.value) >= 100) || null;
  const drawdown = feet.find((i) => i.value != null && Math.abs(i.value) < 100) || null;

  const elevationFt = absolute ? absolute.value : null;
  // Published as a negative when the lake is down; carried as a positive depth below full pond
  // so it reads the same way as every other operator in this codebase.
  const belowFullPondFt = drawdown ? Math.abs(drawdown.value) : null;
  return {
    facility,
    elevationFt,
    belowFullPondFt,
    fullPondFt: (elevationFt != null && belowFullPondFt != null)
      ? Math.round((elevationFt + belowFullPondFt) * 100) / 100 : null,
    elevationAt: absolute ? absolute.at : null,
    drawdownAt: drawdown ? drawdown.at : null,
    discharges,
    updatedAt: ((/Updated:\s*<span>([\s\S]*?)<\/span>/i.exec(flat) || [])[1] || '').trim() || null,
    // Said out loud: two unlabelled numbers were told apart by size.
    note: (absolute && drawdown)
      ? 'elevation and drawdown are published unlabelled; assigned by magnitude and checked by their sum'
      : null,
  };
}
