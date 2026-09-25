// utils/fetch-batch.js — what each source got back from /research/proxy-download-batch.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// Pure, so the rule can be tested without the app (lake-research-engine.js needs a window).
// Scripts/research_lakes.py's fetch_sources() reads the batch the same way.
//
// THREE THINGS THIS READ WRONG:
//   - It paired results with sources BY POSITION, and the batch returned them in the order they
//     finished: TinyFish's, then Scrape.do's, then the special ones. Paired by URL now.
//   - It looked for `reason === 'unhandled'`. The batch says so in `source`, and `reason` says
//     why ('pdf', 'nepis', 'blocked'), so nothing ever reached the one-at-a-time path.
//   - A page from the Scrape.do fallback comes as HTML, because turning it into text does not fit
//     the Worker's 10 ms of CPU; it is made text here, with its lines (js/utils/html-text.js).

import { htmlToText } from './html-text.js';

/**
 * @param {Array<{url: string, type?: string}>} batch  the sources sent, in order
 * @param {Array<object>} results                       the batch's `results`
 * @returns {Array<{src: object, result: object|null, kind: 'text'|'individual'|'failed', text: string}>}
 *   `individual` carries the source to fetch alone; one the server named a PDF has type 'PDF', so
 *   proxy-download fetches it as one whatever its URL says.
 */
export function readBatchResults(batch, results) {
  const byUrl = new Map();
  for (const r of results || []) if (r?.url && !byUrl.has(r.url)) byUrl.set(r.url, r);
  return batch.map((src, j) => {
    const result = byUrl.get(src.url) || (results || [])[j] || null;
    if (result?.source === 'unhandled') {
      return { src: result.reason === 'pdf' ? { ...src, type: 'PDF' } : src, result, kind: 'individual', text: '' };
    }
    const text = result?.html != null ? htmlToText(result.html) : String(result?.text || '');
    // The app's own floor for a usable document, unchanged.
    if (result?.ok && text.length > 200) return { src, result, kind: 'text', text };
    return { src, result, kind: 'failed', text };
  });
}
