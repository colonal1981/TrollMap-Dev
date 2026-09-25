Personal use only, not for distribution or resale; not for navigation.

Documents fetched 2026-09-25 for Scripts/test_extract_window.py, as markdown through TinyFish -- the
fetcher Worker/research/download.js stores documents with. Each is longer than EXTRACT_DOC_CHARS
(20,000) and names its water only past that cut. Lines kept are verbatim and in the page's order;
where a file is an excerpt, whole stretches of lines are left out and nothing else is changed.

- scdnr-2007-parr.md -- https://www.dnr.sc.gov/fish/fwfi/files/2007_annual_report.pdf
  ("2007 Statewide Research – Freshwater Fisheries Job Progress"). The fetched text is 134,011
  characters with Parr first at 93,713, the same numbers the desktop measured on the stored copy.
  Excerpt, 47,817 characters: the first 30,874 characters whole (title page, contents, and the
  smallmouth, sunfish and Santee-Cooper striped bass jobs), then the first ~15,000 characters of
  the Broad River mussel job that names Parr Reservoir (first "Parr" at 31,729), then ~2,000
  characters of the next job (largemouth sampling on Wateree and Secession). The text has no
  heading, no `--- PAGE` marker and no date line: plain PDF text broken only by blank lines.
- nc-reservoir-striped-bass-jordan.md -- https://www.ncwildlife.gov/fishing/understanding-north-carolina-reservoir-striped-bass-and-bodie-bass-anglers/download?attachment
  ("Understanding North Carolina reservoir striped bass and bodie bass anglers"). The fetched text
  is 114,035 characters with "Jordan" first at 33,020 (the stored copy: 84,544 and 25,819). The
  excerpt is its first 53,143 characters, whole lines, unchanged: through the survey paragraph that
  lists Jordan Lake and ~20,000 characters past it.

Both were cut out of the fetched text with a script, never retyped. A Georgia fishing report
fixture was here and is gone: it had been copied out of a tool reply by hand, and it had line breaks
where the stored copy has none.

stored/ -- THE STORED COPIES, as GET /research/get-normalized?lake=<name> returns them: one JSON
file per document, {title, url, fullText, fetchedAt, aliases}, excerpted where a document is over
~150 KB (still longer than the cut, with the water's section past it). The cloud session that wrote
Scripts/test_extract_window.py could not reach workers.dev (the egress proxy refuses it, and
TinyFish's copy of the JSON drops escapes), so the desktop commits these; until then their tests are
reported skipped, naming the file. The names the tests read:

- hartwell-2013-fisheries-investigations.json -- Lake Hartwell, SC: "2013 Fisheries Investigations
  in Lakes and Streams", first section break at 84,691 (the head change).
- blalock-fy2016-17-accountability-report.json -- Lake Blalock, SC: the line "... effective date of
  the section. (June 30, 2015)." (a date line must be a whole line).
- thurmond-sc-freshwater-fishing-regulations.json -- Lake Thurmond, SC: 25SCAB-PP2-RE.pdf, 475,009
  characters on 248 lines; excerpt.
- ocmulgee-ga-fishing-report-2025-07-18.json -- Ocmulgee River, GA: 83,459 characters on one line,
  the flat-text case that goes as its first cut.
- bowen-2021-board-meeting-agenda.json -- Lake Bowen, SC: the SCDNR board packet (June172021.pdf)
  whose top is thick with addresses (the top of the page is counted without its links).
