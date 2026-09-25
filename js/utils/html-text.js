// utils/html-text.js — a fetched page as the text a reader sees, with its lines.
//
// Personal use only, not for distribution or resale; not for navigation.
//
// THE FALLBACK STORED PAGE SOURCE AS ONE LINE. proxy-download-batch's Scrape.do rung read
//
//     html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
//
// which turned every tag into a space, collapsed every line break away, kept what was inside
// <script> and <style>, and left `&#8211;` as six characters. Measured on the desktop on
// 2026-09-25 over 1,677 stored documents: 279 had no line break at all, and many began with the
// Google Tag Manager snippet, WordPress CSS or a JSON-LD block. text-date.js found no date line
// in them, the extraction window found no section, and the Claude packet's units ran together.
//
// WHAT THIS DOES, AND IT FOLLOWS HOW A BROWSER RENDERS THE PAGE rather than a list of sites:
//   - drops the contents of the elements whose contents are never shown as text: script (which
//     includes JSON-LD), style, noscript, template, svg -- and HTML comments;
//   - a line break at each block-level element and at <br>, as the page would be laid out;
//   - a source newline is a space, as it is on screen, except inside <pre>;
//   - decodes entities, once, after tags are gone, so `&lt;b&gt;` stays the text "<b>";
//   - collapses spaces within a line and never across lines.
// Nothing the page says is dropped: only its source code is. An entity this does not know is
// left as written rather than guessed at.
//
// ONE FUNCTION FOR WHAT IS STORED. The app imports this, and Scripts/research_lakes.py runs it
// under node (as it runs doc-relevance.js) rather than keep a Python copy. The Worker's own
// stripHtml() (worker-data.js) and stripHtmlPreserveTables() (facts-util.js) are left as they are:
// their callers flatten the result to one line anyway, inside requests with other work to do, and
// this costs more CPU for the same line. They are not storage.
//
// WHY THE CALLERS RUN IT AND NOT THE WORKER. The Worker has 10 ms of CPU a request on the free
// plan, and /research/proxy-download-batch can fall back to Scrape.do for ten pages in one
// request. Measured in node on 2026-09-25 (test/a-fetched-page-keeps-its-lines.test.js prints it):
// the 85 KB Lake Greenwood page converts in about 0.4 ms, but 1 MB of the three fixture pages
// repeated takes about 10 ms, and 1 MB of dense markup about 20 ms -- the old one-line strip
// already took about 6 ms on the same megabyte. So the batch returns the page's HTML and the
// caller, which has no CPU ceiling, turns it into text. The single-URL proxy-download's Scrape.do
// rung does the same: it sends the page's HTML with its Content-Type.

// A tag's attributes: a quoted value may hold `>` (the Edgefield Advertiser's share link has
// `status=... => https://...` inside its href), as a browser reads it.
const ATTRS = String.raw`(?:=\s*"[^"]*"|=\s*'[^']*'|[^>])*`;
// Elements whose contents are source, not text. svg's <text> is drawing, not prose.
const RAW = new RegExp(String.raw`<(script|style|noscript|template|svg)\b${ATTRS}>[\s\S]*?(?:<\/\1\s*>|$)`, 'gi');
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const PRE = new RegExp(String.raw`<pre\b${ATTRS}>[\s\S]*?<\/pre\s*>`, 'gi');
// The HTML block-level and table-structure elements, plus <br> and <title>: where a browser
// starts a new line.
const BLOCK = new RegExp(String.raw`<\/?(?:address|article|aside|blockquote|body|br|caption|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|head|header|hgroup|hr|html|legend|li|main|nav|ol|option|p|pre|section|summary|table|tbody|td|tfoot|th|thead|title|tr|ul)\b${ATTRS}>`, 'gi');
const TAG = new RegExp(String.raw`<\/?[a-zA-Z!?]${ATTRS}>`, 'g');

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hyphen: '‐', minus: '−',
  lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„',
  laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›',
  hellip: '…', bull: '•', middot: '·', prime: '′', Prime: '″',
  deg: '°', plusmn: '±', times: '×', divide: '÷', frac12: '½', frac14: '¼', frac34: '¾',
  sup1: '¹', sup2: '²', sup3: '³', micro: 'µ', permil: '‰',
  copy: '©', reg: '®', trade: '™', sect: '§', para: '¶', dagger: '†', Dagger: '‡',
  cent: '¢', pound: '£', euro: '€', yen: '¥', iexcl: '¡', iquest: '¿',
  ensp: ' ', emsp: ' ', thinsp: ' ', zwnj: '\u200c', zwj: '\u200d', shy: '',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', ccedil: 'ç',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', Ccedil: 'Ç',
  agrave: 'à', egrave: 'è', auml: 'ä', euml: 'ë', ouml: 'ö', uuml: 'ü', szlig: 'ß',
};
// A named reference needs its semicolon, so `?a=1&copy=2` in a printed URL is left alone.
const ENTITY = /&(?:#(\d{1,7});?|#[xX]([0-9a-fA-F]{1,6});?|([a-zA-Z][a-zA-Z0-9]{1,31});)/g;

function codePoint(n) {
  if (!Number.isFinite(n) || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return null;
  // Windows-1252 in a numeric reference (&#150; for a dash) is what pages mean by it.
  if (n >= 0x80 && n <= 0x9f) {
    const cp1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ'[n - 0x80];
    return cp1252;
  }
  if (n === 10 || n === 13 || n === 9 || n === 12) return ' ';
  return String.fromCodePoint(n);
}

/** Decode HTML character references once. An unknown name is left as written. */
export function decodeEntities(s) {
  return String(s || '').replace(ENTITY, (m, dec, hex, name) => {
    if (dec) return codePoint(parseInt(dec, 10)) ?? m;
    if (hex) return codePoint(parseInt(hex, 16)) ?? m;
    return Object.prototype.hasOwnProperty.call(NAMED, name) ? NAMED[name] : m;
  });
}

/**
 * HTML → the text a reader sees, one rendered line per line.
 * @param {string} html
 * @returns {string}
 */
export function htmlToText(html) {
  let s = String(html || '')
    .replace(COMMENT, ' ')
    .replace(RAW, ' ')
    .replace(PRE, (m) => m.replace(/\r?\n/g, '<br>'));
  // A source line break or run of spaces is one space, as on screen. Only runs that are not
  // already a single space are matched: `\s+` also matched every gap between two words, and on a
  // 1 MB page that one pass cost more than all the others together.
  s = s.replace(/[ \t\r\n\f\v]*[\t\r\n\f\v][ \t\r\n\f\v]*| {2,}/g, ' ')
    .replace(BLOCK, '\n')
    .replace(TAG, ' ');
  if (s.includes('&')) s = decodeEntities(s);
  // Spaces within a line, never across lines. \u00a0 and the Unicode spaces are spaces here.
  return s
    .replace(/[ \t\f\v\u00a0\u2000-\u200a\u202f\u205f\u3000]{2,}|[\t\f\v\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
    .replace(/ *\n[ \n]*/g, '\n')
    .trim();
}

/**
 * Is this body a PDF, by what the server sent? The Content-Type says so, or the bytes begin with
 * the PDF header. The URL is not asked: `ncwildlife.gov/media/4600/download?attachment=` is a PDF
 * with no `.pdf` in it, and was stored as 212,503 characters of its raw bytes.
 */
export function isPdfBody(contentType, body) {
  if (/\bapplication\/(?:x-)?pdf\b/i.test(String(contentType || ''))) return true;
  // Bytes are looked at as bytes: decoding a PDF as UTF-8 to find its header is the work this
  // exists to avoid (proxy-target-type.test.js has the wrangler tail of that costing the 10 ms).
  const head = body instanceof Uint8Array || body instanceof ArrayBuffer
    ? String.fromCharCode(...new Uint8Array(body instanceof ArrayBuffer ? body : body.buffer,
        body instanceof ArrayBuffer ? 0 : body.byteOffset, Math.min(1024, body.byteLength)))
    : String(body || '').slice(0, 1024);
  return /^\s*%PDF-/.test(head);
}

/** A stored text that is a PDF's bytes rather than its text. */
export function isPdfText(text) {
  return isPdfBody('', text);
}

/**
 * Is this body HTML, by what the server sent? A text/plain or JSON answer is kept as sent,
 * because its newlines are its lines and reading it as HTML would fold them into spaces.
 */
export function isHtmlBody(contentType, body) {
  if (/html|xml/i.test(String(contentType || ''))) return true;
  return /^\s*</.test(String(body || '').replace(/^\uFEFF/, '').slice(0, 1024));
}
