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
- ga-fishing-report-2025-07-18.md -- https://georgiawildlife.blog/2025/07/18/georgia-fishing-report-july-18-2025/
  ("Georgia Fishing Report: July 18, 2025"). The whole page as TinyFish returned it, 43,132
  characters, "Ocmulgee" first at 38,018 under "#### RIVER REPORT". The stored copy the desktop
  measured is 83,459 characters with Ocmulgee at 70,898 -- a fuller fetch of the same page.
- nc-reservoir-striped-bass-jordan.md -- https://www.ncwildlife.gov/fishing/understanding-north-carolina-reservoir-striped-bass-and-bodie-bass-anglers/download?attachment
  ("Understanding North Carolina reservoir striped bass and bodie bass anglers"). The fetched text
  is 114,035 characters with "Jordan" first at 33,020 (the stored copy: 84,544 and 25,819). The
  excerpt is its first 53,143 characters, whole lines, unchanged: through the survey paragraph that
  lists Jordan Lake and ~20,000 characters past it.

NOT HERE: the SC Freshwater Fishing Regulations (dnr.sc.gov/regs/pdf/25SCAB-PP2-RE.pdf, Thurmond).
From the cloud session TinyFish got 403 from dnr.sc.gov's regs folder and Firecrawl refused the
file as over its 50 MiB limit; the direct host is not reachable from there. The NC report stands in
for it as the third long document with the water past the cut.
