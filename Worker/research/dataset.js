// research/dataset.js — split from worker-research.js (behavior-preserving)
//
// The NEPIS helpers discover.js reads. handleResearchDatasetHunt and the target table, keyword
// list, URL scorer and query variants only it used went with /research/dataset-hunt on
// 2026-09-25: no caller anywhere.

// NEPIS document IDs confirmed as wrong-lake false positives — score -9999 to guarantee exclusion
const KNOWN_BAD_NEPIS_IDS = new Set([
  '91024IW5', // "Monticello" wastewater plant / Lake Decatur IL — not Lake Monticello SC
  '9100D35L', // "Monticello" wastewater plants (N+S) / Pearson Creek + White Oak Creek — not Lake Monticello SC
]);

// Build EPA NSCEP search-results URL(s) for a lake.
// Historical EPA "Report on Lake …" series (1970s–80s) uses INCONSISTENT naming:
//   Most lakes:  "Report on Lake Murray"   (Lake before name)
//   Wateree etc: "Report on Wateree Lake"  (name before Lake)
// Using title filter "Report on" (not "Report on Lake") catches BOTH conventions
// since the lake name is in the Query field anyway.
// LIFTED OUT OF buildNepisSearchUrl 2026-09-16 so discover.js can disambiguate a search by state
// without writing a second copy of the same four rows. `"Broad River"` returns the SC one, the NC
// one, the French Broad and Virginia's New River; `"Broad River" South Carolina` drops the last
// two outright. Measured that day.
const STATE_NAMES = {
  SC: 'South Carolina', NC: 'North Carolina', GA: 'Georgia', VA: 'Virginia', TN: 'Tennessee',
};

/** The spelled-out state, which is what a fishing page says. Falls back to SC, as it always did. */
function stateFullName(state) {
  return STATE_NAMES[String(state || 'SC').toUpperCase()] || 'South Carolina';
}

function buildNepisSearchUrl(lakeName, state, queryOverride = null) {
  const baseName = String(lakeName || '').replace(/^Lake\s+/i, '').replace(/,\s*(SC|NC|GA|VA|TN).*$/i, '').trim();
  const stateName = stateFullName(state);
  const query = encodeURIComponent(queryOverride || baseName || stateName);
  // Use "Report on" (not "Report on Lake") so both naming conventions match:
  //   "Report on Lake Murray" AND "Report on Wateree Lake"
  const titleField = encodeURIComponent('Report on');
  // Indexes cover historical EPA lake reports (1970s–2020)
  const indexes = [
    '2016 Thru 2020', '2011 Thru 2015', '2006 Thru 2010', '2000 Thru 2005',
    '1995 Thru 1999', '1991 Thru 1994', '1986 Thru 1990', '1981 Thru 1985',
    '1976 Thru 1980', 'Prior to 1976'
  ].map(i => `Index=${encodeURIComponent(i)}`).join('&');
  return `https://nepis.epa.gov/Exe/ZyNET.exe?ZyAction=ZyActionS&User=ANONYMOUS&Password=anonymous&Client=EPA&SearchBack=ZyActionL&SortMethod=h%7C-&MaximumDocuments=15&ImageQuality=r85g16%2Fr85g16%2Fx150y150g16%2Fi500&Display=hpfr&DefSeekPage=&Toc=&TocEntry=&TocRestrict=n&QField=title%5E${titleField}&UseQField=title&Docs=&SearchMethod=1&Time=&FullText=&IntQFieldOp=1&Query=${query}&ExtQFieldOp=1&FuzzyDegree=0&${indexes}`;
}

// Convert an EPA NSCEP document viewer/landing URL into the raw-text download URL.
// The viewer endpoint uses ZyActionD=ZyDocument and displays scanned page images.
// The same .txt endpoint with ZyActionW=Download returns the OCR/plain-text file
// referenced by the File= parameter.
function toNepisRawTextUrl(landingUrl) {
  try {
    const url = new URL(landingUrl);
    if (!/nepis\.epa\.gov/i.test(url.hostname)) return null;
    // .txt may be in pathname OR in Dockey= query param (ZyPURL.cgi?Dockey=9100D9KA.TXT)
    const hasTxtInPath = /\.txt$/i.test(url.pathname);
    const hasTxtInQuery = /Dockey=[^&]*\.txt/i.test(url.search);
    if (!hasTxtInPath && !hasTxtInQuery) return null;
    // ZyPURL.cgi?Dockey=XXXX.TXT — direct raw text URL, return as-is
    if (/ZyPURL\.cgi/i.test(url.pathname) && hasTxtInQuery) return landingUrl;
    // Already a download link — nothing to do.
    if (/ZyActionW=Download/i.test(url.search)) return landingUrl;
    // Switch from the viewer action to the download action, keeping File= etc.
    url.searchParams.delete('ZyActionD');
    url.searchParams.set('ZyActionW', 'Download');
    // Retain existing SearchMethod and Display if present; only default if missing
    if (!url.searchParams.has('SearchMethod')) {
      url.searchParams.set('SearchMethod', '1');
    }
    if (!url.searchParams.has('Display')) {
      url.searchParams.set('Display', 'hpfr');
    }
    return url.toString();
  } catch (e) {
    return null;
  }
}

export { STATE_NAMES, stateFullName, KNOWN_BAD_NEPIS_IDS, buildNepisSearchUrl, toNepisRawTextUrl };
