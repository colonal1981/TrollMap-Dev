#!/usr/bin/env python3
r"""
uncharted_report.py — which waters with boat ramps have no bathymetry, and where to go look.

THE QUESTION
------------
Ryan, 2026-08-08: "is there a way to compare the DNR feeds from the worker with our list and
figure out which lakes are actually missing charts... so i can go see they are really missing or
not in activecaptain?"

Yes. The output is a checklist sorted by how many ramps a water has, so the time spent verifying
goes to water people actually launch on, and every row carries a lat/lon to type into
ActiveCaptain.

WHAT "MISSING CHARTS" MEANS HERE
--------------------------------
Not `charted`. That field is measured and untrustworthy: Willow Lake reads 0.988, Everetts Lake
0.908, Bear Garden Swamp 0.855 — and on 2026-08-08 all three turned out to have NO CONTOUR LINE
anywhere inside their bounds. It counts depth-area coverage and a 0 ft polygon counts, so it says
"charted" for water nobody has sounded.

So this asks the blunt question directly: **are there contour vertices inside this lake's box in
what we extracted?** Same test as `refresh_yield.py`, same caveat — a bbox is generous, so a lake
reported CHARTED is definitely fine and a lake reported UNCHARTED is worth a look rather than
proven empty.

MATCHING, AND WHY IT IS DELIBERATELY TIMID
------------------------------------------
On 2026-08-07 I wrote a loose name matcher, ran it over stale local dumps, and reported that 65%
of DNR waterbodies were missing from the registry. That number was an artefact of my matcher. The
app has `registry/lake_aliases.json` and a merge that checks POSITION as well as name, and I had
used neither.

So the order here is: the alias file, then an exact name match, then a match confirmed by a ramp
falling inside the lake's own bounding box. Nothing is matched on a fuzzy name alone. A row that
does not match is reported as UNKNOWN with its ramp position rather than being forced onto the
nearest-looking lake — an unmatched row costs a minute to check, and a wrong match hides a lake
forever.

USAGE
-----
    py scripts/uncharted_report.py --worker https://trollmap-worker.colonal1981.workers.dev `
                                   --out registry\_uncharted.csv

    # or offline, from dumps already on disk
    py scripts/uncharted_report.py --dumps registry --out registry\_uncharted.csv

Reads only. Writes one CSV.
"""
from __future__ import annotations
import argparse, csv, gzip, json, math, os, sys, urllib.request
from collections import defaultdict

STATES = ("SC", "NC", "GA", "TN")
FEEDS = ("ramps", "paddle")
CELL = 0.01


# ── the app's own normalisation, copied from js/data/access-index.js ──────────────────────────
def norm_key(name: str) -> str:
    s = str(name or "").lower().replace("&", " and ")
    out = []
    for ch in s:
        out.append(ch if ch.isalnum() else " ")
    s = " ".join("".join(out).split())
    # WHOLE WORDS, NOT SUBSTRINGS. access-index.js strips these off the raw string, which is fine
    # for the ramp names it was written for ("Dreher Island Boat Ramp"). This file feeds it
    # WATERBODY names, where a substring strip of "the" turns Bethel into "be l" and Weatherly
    # into "wea rly". Same junk list, applied at word boundaries.
    for phrase in ("boat ramp", "access area"):
        s = s.replace(phrase, " ")
    drop = {"ramp", "landing", "access", "launch", "public", "the"}
    return " ".join(t for t in s.split() if t not in drop)


def core(name: str) -> str:
    """Drop a parenthetical and anything after a comma, then normalise. County/state suffixes."""
    s = str(name or "").split("(")[0].split(",")[0]
    return norm_key(s)


# The still-water family. All four words name the same kind of thing, and which one a given
# agency reaches for is a house style, not a fact about the water.
STILL = {"lake", "reservoir", "pond", "impoundment"}


def stem(name: str) -> str:
    """
    A name reduced to what identifies the water rather than what KIND of water it is.

    2026-08-08, first real run: 429 of 726 DNR waterbodies reported NO REGISTRY ROW, and the top
    three by ramp count were `Kentucky Reservoir` (66 ramps), `Old Hickory Reservoir` (38) and
    `Watts Bar Reservoir` (36). The registry holds `Kentucky Lake`, 144,086 acres, charted 0.95,
    and `Watts Bar Lake`, 33,441 acres. One word hid the two biggest impoundments in Tennessee.
    Ryan, reading the output: "some of this has to be a naming thing and not actually missing."

    Only the still-water family is folded. A river keeps the word `river`, so `Kentucky Reservoir`
    can never land on a Kentucky River. Tokens are then sorted, so `Lake Marvin` and `Marvin Lake`
    reduce alike.

    THIS IS A LOOSE MATCH AND IS NEVER TRUSTED ALONE. Every stem hit must be confirmed by an
    access point falling inside the candidate's own bounding box before it counts. Matching on a
    loose name by itself is how I invented a 452-lake problem on 2026-08-07.
    """
    toks = core(name).split()
    if any(t in STILL for t in toks):
        toks = [t for t in toks if t not in STILL]
    return " ".join(sorted(toks))


def confirm(rec: dict, pts: list[dict], pad: float = 0.02) -> int:
    """
    How many of this waterbody's access points fall inside the candidate's bounds.

    Zero means the name matched and the water did not. `pad` is about half a ramp's worth of
    coordinate slop (~2 km), not a search radius.
    """
    b = rec.get("bounds_wsen")
    if not (isinstance(b, list) and len(b) == 4):
        return 0
    return sum(1 for p in pts
               if b[0] - pad <= p["lon"] <= b[2] + pad and b[1] - pad <= p["lat"] <= b[3] + pad)


# Cloudflare sits in front of the Worker and refuses the default `Python-urllib/3.x` agent with
# a 403 before the route is ever reached — /ramps itself has no auth, it just proxies ArcGIS. A
# browser agent is all it wants. (Confirmed 2026-08-08: all eight feeds 403 without this.)
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/126.0.0.0 Safari/537.36")


def fetch(url: str, ua: str = UA):
    req = urllib.request.Request(url, headers={
        "User-Agent": ua,
        "Accept": "application/json, text/plain, */*",
    })
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def load_feeds(worker: str | None, dumps: str | None, ua: str = UA,
               dump_to: str | None = None) -> dict[str, list[dict]]:
    """waterbody display name -> list of access points, across every state and feed."""
    out: dict[str, list[dict]] = defaultdict(list)
    for st in STATES:
        for kind in FEEDS:
            try:
                if worker:
                    d = fetch(f"{worker.rstrip('/')}/{kind}?state={st}", ua)
                else:
                    p = os.path.join(dumps, f"_dnr_{kind}_{st.lower()}.json")
                    if not os.path.exists(p):
                        continue
                    with open(p, encoding="utf-8") as fh:
                        d = json.load(fh)
            except Exception as e:
                print(f"  !! {kind} {st}: {e}", file=sys.stderr)
                if "403" in str(e):
                    print("     403 is Cloudflare refusing the client, not the Worker refusing "
                          "you. If it persists, dump the feeds with curl.exe and use --dumps:",
                          file=sys.stderr)
                    print(f"       curl.exe -s \"{worker}/{kind}?state={st}\" | "
                          f"Out-File -Encoding utf8 registry\\_dnr_{kind}_{st.lower()}.json",
                          file=sys.stderr)
                continue
            if dump_to:
                # So tuning a threshold never costs another eight round trips to Cloudflare.
                os.makedirs(dump_to, exist_ok=True)
                with open(os.path.join(dump_to, f"_dnr_{kind}_{st.lower()}.json"),
                          "w", encoding="utf-8") as fh:
                    json.dump(d, fh)
            wbs = d.get("waterbodies") or {}
            got = 0
            for name, pts in wbs.items():
                if not name or str(name).lower().startswith("unknown"):
                    continue
                for p in (pts if isinstance(pts, list) else []):
                    lat, lon = p.get("lat"), p.get("lon")
                    if lat is None or lon is None:
                        continue
                    out[f"{name}|{st}"].append({"lat": float(lat), "lon": float(lon),
                                                "name": p.get("name") or "", "kind": kind})
                    got += 1
            print(f"  {kind} {st}: {len(wbs)} waterbodies, {got} access points")
    return out


def medoid(pts: list[dict]) -> dict:
    """
    A REAL access point near the middle of the cluster. Never a synthetic average.

    2026-08-08. The report gave 33.40629, -80.92103 for North Fork Edisto River and Ryan: "can
    you check this coords... i dont think they are right". They were not. That is the centre of
    the registry row's bounding box, and the box is 11.6 km by 31.6 km around a river that winds
    diagonally across it, so its centre is dry ground. Cape Fear River's box is 78 km by 136 km —
    its centre is not within sight of the water. A bbox centre only means anything for something
    roughly as wide as it is long, which a river never is.

    Averaging the access points instead has the same disease: the mean of eight ramps strung along
    a bend sits off-channel. So this returns one of the ACTUAL points. It is on water by
    construction, because somebody launches a boat there.
    """
    if len(pts) == 1:
        return pts[0]
    mlat = sum(p["lat"] for p in pts) / len(pts)
    mlon = sum(p["lon"] for p in pts) / len(pts)
    k = math.cos(math.radians(mlat))      # a degree of longitude is shorter this far north
    return min(pts, key=lambda p: (p["lat"] - mlat) ** 2 + ((p["lon"] - mlon) * k) ** 2)


def farthest_pair(pts: list[dict]) -> list[dict]:
    """The two access points furthest apart — the ends of the reach, to check either side."""
    if len(pts) < 2:
        return []
    k = math.cos(math.radians(sum(p["lat"] for p in pts) / len(pts)))
    if len(pts) > 200:                       # no feed comes close, but do not be quadratic on faith
        return [min(pts, key=lambda p: p["lat"]), max(pts, key=lambda p: p["lat"])]
    best, pair = -1.0, []
    for i, p in enumerate(pts):
        for q in pts[i + 1:]:
            d = (p["lat"] - q["lat"]) ** 2 + ((p["lon"] - q["lon"]) * k) ** 2
            if d > best:
                best, pair = d, [p, q]
    return pair


def bbox_center(rec: dict | None) -> str:
    """The centre of the box the verdict is measured over. Reference only — not a destination."""
    b = (rec or {}).get("bounds_wsen")
    if not (isinstance(b, list) and len(b) == 4):
        return ""
    return f"{(b[1] + b[3]) / 2:.5f}, {(b[0] + b[2]) / 2:.5f}"


def span_km(pts: list[dict]) -> float:
    """Widest extent of the access points. One coordinate cannot speak for a 31 km river."""
    if len(pts) < 2:
        return 0.0
    lats = [p["lat"] for p in pts]
    lons = [p["lon"] for p in pts]
    k = math.cos(math.radians(sum(lats) / len(lats)))
    return max((max(lats) - min(lats)) * 111.0, (max(lons) - min(lons)) * 111.0 * k)


def base_rates(rows: list[dict], grid: dict) -> dict[str, tuple[int, int]]:
    """
    How often does each kind of water in the registry actually have contours?

    2026-08-08. I wrote "Garmin does not contour moving water" into a flag's help text and used it
    to drop four rivers and a swamp off Ryan's checklist. Ryan: "this is a straight lie". It was.
    I had measured nothing, and Garmin contours a great deal of river — the Tennessee, the
    Cumberland, the Savannah and every navigable reach besides.

    A filter that hides rows needs a number under it. This is that number, off the same grid every
    other verdict in this file uses, so the flag can be judged rather than believed.

    THE DENOMINATOR IS HONEST BUT NOT FLATTERING: it counts every registry row, including water
    outside the tiles that have been extracted, which are read here as uncontoured. So all three
    rates are understated by the same missing coverage. The comparison between types survives
    that; the absolute numbers do not, and are not offered as coverage figures.
    """
    tally: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for r in rows:
        b = r.get("bounds_wsen")
        if not (isinstance(b, list) and len(b) == 4):
            continue
        t = tally[r.get("feature_type") or "(untyped)"]
        t[1] += 1
        if in_box(grid, b):
            t[0] += 1
    return {k: (v[0], v[1]) for k, v in tally.items()}


def near_access(grid: dict, pts: list[dict], pad: float = 0.015) -> int:
    """
    Contour vertices within ~1.5 km of any of this waterbody's access points.

    THIS IS WHAT MAKES THE LIST SHORT ENOUGH TO CHECK BY HAND. 429 waterbodies came back with no
    registry row, and Ryan's answer to that was the correct one: "429 wasn't going to be that".
    But most of those are not uncharted — Garmin has sounded the water and we simply have no row
    for it, which is a registry gap for me to close, not something to go verify in ActiveCaptain.
    A row is only worth his minute if there is no bathymetry ANYWHERE near where you launch.

    1.5 km discriminates comfortably. Adams Mill Pond's nearest contour was 8.40 km away on the
    card and 0.08 km on the refreshed tile, so the gap between "sounded" and "not" is two orders
    of magnitude, not a judgement call. Wider than this and a ramp on a river arm starts picking
    up the big lake next door and reads as charted when it is not.
    """
    total, seen = 0, set()
    for p in pts:
        for x in range(int((p["lon"] - pad) // CELL), int((p["lon"] + pad) // CELL) + 1):
            for y in range(int((p["lat"] - pad) // CELL), int((p["lat"] + pad) // CELL) + 1):
                if (x, y) not in seen:
                    seen.add((x, y))
                    total += grid.get((x, y), 0)
    return total


def index_contours(roots: list[str]) -> dict[tuple[int, int], int]:
    grid: dict[tuple[int, int], int] = defaultdict(int)
    for root in roots:
        if not os.path.isdir(root):
            print(f"  (skipping {root} — not a directory)", file=sys.stderr)
            continue
        n = 0
        for name in sorted(os.listdir(root)):
            if not (name.endswith(".geojson") or name.endswith(".geojson.gz")):
                continue
            op = gzip.open if name.endswith(".gz") else open
            try:
                with op(os.path.join(root, name), "rt", encoding="utf-8") as fh:
                    feats = json.load(fh).get("features") or []
            except Exception as e:
                print(f"  !! {name}: {e}", file=sys.stderr)
                continue
            n += 1
            for f in feats:
                g = f.get("geometry") or {}
                cs = g.get("coordinates") or []
                for line in ([cs] if g.get("type") == "LineString" else cs):
                    for p in line:
                        try:
                            grid[(int(p[0] // CELL), int(p[1] // CELL))] += 1
                        except (TypeError, IndexError):
                            pass
        print(f"  {root}: {n} tiles")
    return grid


def in_box(grid, b) -> int:
    w, s, e, n = b
    t = 0
    for x in range(int(w // CELL), int(e // CELL) + 1):
        for y in range(int(s // CELL), int(n // CELL) + 1):
            t += grid.get((x, y), 0)
    return t


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--worker", help="worker base url — the LIVE feeds")
    src.add_argument("--dumps", help="directory of _dnr_*.json dumps, for offline runs")
    ap.add_argument("--registry", default="registry/lake_index.json")
    ap.add_argument("--aliases", default="registry/lake_aliases.json")
    # ONE CONTOUR DIRECTORY, NOT TWO. The default used to merge extract_new_C/contours in,
    # which by 2026-08-22 was a 2026-08-08 tray of 207 tiles decoded before the 83 ft ceiling
    # and the marine area fix. Every tile in it was also in extract/, older and shallower, so
    # the merge could only ever pull the answer backwards. The tray is in _to_delete/ now.
    # It still takes a comma-separated list, for when there really are two.
    ap.add_argument("--contours", default="extract/contours",
                    help="comma-separated contour directories, merged")
    ap.add_argument("--out", default="registry/_uncharted.csv")
    ap.add_argument("--user-agent", default=UA,
                    help="override if Cloudflare gets fussier than it already is")
    ap.add_argument("--min-ramps", type=int, default=1,
                    help="how many TRAILERED boat ramps a water needs before it lands on the "
                         "checklist (default 1). 0 includes paddle-only put-ins, which is mostly "
                         "creeks.")
    ap.add_argument("--access-pad", type=float, default=0.015,
                    help="degrees around an access point to search for contours when there is no "
                         "registry row (default 0.015, about 1.5 km)")
    ap.add_argument("--lakes-only", action="store_true",
                    help="drop rows the registry calls river or coastal. READ THE BASE RATES the "
                         "run prints before using this — if river rows are contoured about as "
                         "often as lake rows, an uncontoured river is a finding and this flag "
                         "hides it. Rows with no registry row are kept either way.")
    ap.add_argument("--spread-km", type=float, default=5.0,
                    help="when a water's access points are spread at least this far apart, print "
                         "both ends as well as the middle (default 5). One coordinate cannot "
                         "speak for a river.")
    ap.add_argument("--dump-feeds", metavar="DIR",
                    help="save the raw DNR feeds here so the next run can use --dumps and skip "
                         "the network entirely")
    a = ap.parse_args()

    with open(a.registry, encoding="utf-8") as fh:
        raw = json.load(fh)
    rows = raw if isinstance(raw, list) else [{**v, "slug": v.get("slug", k)} for k, v in raw.items()]
    by_slug = {r["slug"]: r for r in rows}

    aliases = {}
    if os.path.exists(a.aliases):
        with open(a.aliases, encoding="utf-8") as fh:
            aliases = {core(k): v for k, v in json.load(fh).items()}
    print(f"registry {len(rows)} rows, {len(aliases)} aliases")

    # Name indexes across every name a lake has ever been known by. BOTH ARE MULTIMAPS: SC's
    # ramp feed lists a Lake Placid, and so does the registry — twice, one in TN and one in GA.
    # A dict keyed by name keeps whichever row was inserted first and silently answers with it,
    # which is how SC's Lake Placid came back as a 38-acre pond outside Jackson, Tennessee.
    exact: dict[str, list[dict]] = defaultdict(list)
    stems: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        for n in (r.get("name"), r.get("display_name"), r.get("legacy_display_name"),
                  *(r.get("legacy_display_names") or [])):
            if not n:
                continue
            if r not in exact[core(n)]:
                exact[core(n)].append(r)
            if r not in stems[stem(n)]:
                stems[stem(n)].append(r)

    print("loading feeds...")
    feeds = load_feeds(a.worker, a.dumps, a.user_agent, a.dump_feeds)
    if not feeds:
        print("\nno feeds loaded — nothing to compare. See the 403 note above.", file=sys.stderr)
        return 1
    print("indexing contours...")
    grid = index_contours([p.strip() for p in a.contours.split(",") if p.strip()])

    out_rows = []
    extremes: dict[tuple[str, str], list[dict]] = {}
    for key, pts in feeds.items():
        name, st = key.rsplit("|", 1)
        c = core(name)
        rec, how = None, ""

        slug = aliases.get(c)
        if slug and slug in by_slug:
            rec, how = by_slug[slug], "alias"      # the alias file is hand-made; take it as given

        if rec is None:
            # POSITION DECIDES BETWEEN NAME CANDIDATES. It used to merely annotate a single
            # already-chosen row, and the annotation only reached the CSV, so the console showed
            # two confident wrong answers on 2026-08-08: SC's Lake Placid reported against a TN
            # row 500 km away, and a TN "New Lake" reported against New Lake, North Carolina —
            # 4,909 acres at -76.34, which is not in Tennessee and never has been.
            #
            # Exact names are offered first and the fold second, but neither is accepted without
            # an access point inside the row's own bounds.
            cands = [(r, "name") for r in exact.get(c, [])]
            for r in stems.get(stem(name), []):
                if not any(r is x for x, _ in cands):
                    cands.append((r, "name+lake/reservoir"))

            hits = [(confirm(r, pts), r, h) for r, h in cands]
            hits = [t for t in hits if t[0] > 0]
            if hits:
                # Most access points inside wins; area breaks a tie, because a ramp on a big
                # lake's arm often also falls in a little pond's padded box, never the reverse.
                hits.sort(key=lambda t: (-t[0], -(t[1].get("area_acres") or 0)))
                _, rec, how = hits[0]
            elif cands:
                # The name is in the registry, but not HERE. Say so rather than reporting a
                # bare NO REGISTRY ROW, because these are the rows most likely to be a genuine
                # namesake and the ones I have gotten wrong before.
                how = (f"{len(cands)} row(s) share this name, none with an access point inside "
                       f"its bounds — namesake, or our bounds are wrong")

        # WHERE TO GO LOOK. Always a real access point — see medoid().
        mid = medoid(pts)
        lat, lon = mid["lat"], mid["lon"]
        extremes[(name, st)] = farthest_pair(pts)

        if rec is None:
            # No row is not the same as no soundings. Ask the tiles directly.
            verts = near_access(grid, pts, a.access_pad)
            verdict = "NO ROW, CHARTED NEARBY" if verts else "NO ROW, NO CONTOURS"
            acres, slug_out = "", ""
        else:
            b = rec.get("bounds_wsen")
            verts = in_box(grid, b) if isinstance(b, list) and len(b) == 4 else 0
            verdict = "CHARTED" if verts else "UNCHARTED"
            acres = round(rec.get("area_acres") or 0)
            slug_out = rec["slug"]
            # The bbox centre used to overwrite the coordinate here. It is kept as its own column
            # because it is the box the CHARTED/UNCHARTED verdict is measured over, and when the
            # two coordinates disagree wildly that is itself worth seeing — but it is not where
            # anyone should be told to go look.

        # A TRAILERED RAMP AND A KAYAK PUT-IN ARE NOT THE SAME EVIDENCE. Both feeds were merged
        # into one "ramps" count, which is why a creek with a paddle access sorted alongside a
        # reservoir. A boat ramp means water someone tows a boat to; that is the water worth
        # verifying first, and it is a free signal that was already in the feed name.
        trailered = sum(1 for p in pts if p["kind"] == "ramps")

        out_rows.append({
            "verdict": verdict, "waterbody": name, "state": st, "ramps": len(pts),
            "boat_ramps": trailered, "paddle": len(pts) - trailered,
            # Reported so rows can be COMPARED against the measured base rate below, not so a
            # type can be assumed uninteresting. See base_rates().
            "type": (rec.get("feature_type") or "") if rec else "",
            "acres": acres, "slug": slug_out, "matched_by": how,
            "contour_vertices": verts,
            "charted_field": rec.get("charted") if rec else "",
            "shipped": rec.get("shipped") if rec else "",
            "lat": round(lat, 5), "lon": round(lon, 5),
            "at_ramp": mid.get("name") or "",
            "span_km": round(span_km(pts), 1),
            # Read off `rec`, not off the loop's `b`, which is only assigned on the matched
            # branch and would otherwise carry the PREVIOUS waterbody's box into this row.
            "bbox_center": bbox_center(rec),
        })

    order = {"UNCHARTED": 0, "NO ROW, NO CONTOURS": 1, "NO ROW, CHARTED NEARBY": 2, "CHARTED": 3}
    out_rows.sort(key=lambda r: (order.get(r["verdict"], 4), -r["boat_ramps"], -r["ramps"]))

    os.makedirs(os.path.dirname(os.path.abspath(a.out)) or ".", exist_ok=True)
    with open(a.out, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(out_rows[0].keys()))
        w.writeheader()
        w.writerows(out_rows)

    tally = defaultdict(int)
    for r in out_rows:
        tally[r["verdict"]] += 1
    print(f"\n{len(out_rows)} waterbodies with access points")
    for k in ("UNCHARTED", "NO ROW, NO CONTOURS", "NO ROW, CHARTED NEARBY", "CHARTED"):
        print(f"  {k:<24} {tally[k]}")
    print("  (NO ROW, CHARTED NEARBY is mine to fix — Garmin sounded it, we have no registry")
    print("   row. Nothing to verify there.)")

    folded = [r for r in out_rows if r["matched_by"] == "name+lake/reservoir"]
    if folded:
        folded.sort(key=lambda r: -r["ramps"])
        print(f"\n{len(folded)} matched only after folding Lake/Reservoir/Pond, then confirmed by "
              f"an access point inside the bounds. Largest:")
        for r in folded[:8]:
            print(f"  {r['ramps']:>3} ramps  {r['waterbody'][:30]:<30} -> {r['slug'][:28]:<28} "
                  f"{str(r['acres']):>7} ac  {r['verdict']}")

    # THE CHECKLIST. One list, short, and every row on it earns its place: no bathymetry within
    # 1.5 km of a place you can put a boat in. Everything else is either fine or my problem.
    rates = base_rates(rows, grid)
    print("\nhow often each kind of registry water has contours, measured not assumed:")
    for t, (hit, tot) in sorted(rates.items(), key=lambda kv: -kv[1][1]):
        print(f"  {t:<10} {hit:>5} of {tot:>5}  {hit / tot * 100:5.1f}%" if tot else f"  {t}: none")
    print("  (understated across the board — rows outside the extracted tiles read as")
    print("   uncontoured. The comparison between types is the part that holds.)")

    pool = [r for r in out_rows if r["verdict"] in ("UNCHARTED", "NO ROW, NO CONTOURS")]
    if a.lakes_only:
        pool = [r for r in pool if r["type"] in ("lake", "")]
    check = [r for r in pool if r["boat_ramps"] >= a.min_ramps]
    hidden = sum(1 for r in pool if r["boat_ramps"] < a.min_ramps)

    print(f"\n{'='*78}")
    print(f"CHECK THESE IN ACTIVECAPTAIN — {len(check)} waters, no contours within "
          f"{a.access_pad * 111:.1f} km of a boat ramp")
    print(f"{'='*78}")
    for r in check:
        tag = "" if r["slug"] else "  (no registry row)"
        print(f"  {r['boat_ramps']:>2} ramps  {r['waterbody'][:30]:<30} {r['state']} "
              f"{(r['type'] or '?'):<8} {str(r['acres']) or '?':>7} ac{tag}")
        print(f"            at {r['lat']}, {r['lon']}"
              + (f"  ({r['at_ramp'][:38]})" if r["at_ramp"] else ""))
        # ONE COORDINATE CANNOT SPEAK FOR A LONG RIVER. North Fork Edisto's ramps are strung over
        # 31 km; checking the middle one proves nothing about either end, so name the extremes.
        if r["span_km"] >= a.spread_km:
            ends = extremes.get((r["waterbody"], r["state"]))
            if ends:
                print(f"            spans {r['span_km']:.0f} km — also check "
                      + "  and  ".join(f"{p['lat']:.5f}, {p['lon']:.5f}" for p in ends))
    if hidden:
        print(f"\n  ({hidden} more have only paddle/kayak access — creeks and put-ins, mostly. "
              f"--min-ramps 0 to see them.)")

    print(f"\nwrote {a.out}")
    print("A bbox is generous, so CHARTED is solid and UNCHARTED means 'go look'. Paste the")
    print("lat/lon into ActiveCaptain — the ones with the most ramps are worth your time first.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
