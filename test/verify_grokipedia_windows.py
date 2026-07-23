"""
Windows-friendly Python test for Grokipedia/Wikipedia citation extraction
Uses TinyFish Python client to verify that extractLinks surfaces right agency domains

Install:
    pip install tinyfish

Set env:
    set TINYFISH_API_KEY=your_key   (Windows CMD)
    or $env:TINYFISH_API_KEY='your_key'  (PowerShell)

Run:
    python test/verify_grokipedia_windows.py

This replaces 40 hardcoded queries with 5 free searches + citation following.
"""

import os
import re
from urllib.parse import urlparse

try:
    from tinyfish import TinyFish
except ImportError:
    print("TinyFish not installed. Run: pip install tinyfish")
    exit(1)

# Config
LAKES = [
    # Good coverage
    "Lake Wateree, SC",
    "Lake Murray, SC",
    "Lake Hartwell, SC/GA",
    "Lake Lanier, GA",
    "Lake Allatoona, GA",
    "Lake Greenwood (South Carolina)",
    # Poor coverage
    "Auman Lake, NC",
    "John D. Long Lake, NC",
    "Lake Blalock, SC",
    "Lake Bowen, SC",
    "Bonnie Doone Lake, NC",
]

HIGH_VALUE_DOMAINS = [
    "usace.army.mil",
    "tva.com",
    "dnr.sc.gov",
    "des.sc.gov",
    "ncwildlife.gov",
    "ncwildlife.org",
    "georgiawildlife.com",
    "tn.gov",
    "duke-energy.com",
    "epa.gov",
    "usgs.gov",
    "ferc.gov",
    "santeecooper.com",
    "southcarolinaparks.com",
    "greenwoodcounty",
    ".edu",
]

def is_high_value(url):
    try:
        host = urlparse(url).hostname or ""
        host = host.lower()
        for domain in HIGH_VALUE_DOMAINS:
            if domain in host:
                return True
        return False
    except:
        return False

def extract_links_with_tinyfish(urls, api_key=None):
    """Fetch URLs with TinyFish and return links"""
    client = TinyFish(api_key=api_key) if api_key else TinyFish()
    result = client.fetch.get_contents(
        urls=urls,
        format="markdown",
        links=True,
        image_links=True,
    )
    return result.results

def main():
    api_key = os.getenv("TINYFISH_API_KEY")
    if not api_key:
        print("WARNING: TINYFISH_API_KEY not set, trying without (may fail)")
    
    client = TinyFish(api_key=api_key) if api_key else TinyFish()

    for lake in LAKES:
        base = re.sub(r'^Lake\s+', '', lake, flags=re.I)
        base = re.sub(r',.*$', '', base).strip()
        print(f"\n=== {lake} (base: {base}) ===")

        # 1. Grokipedia search
        try:
            search = client.search.search(
                query=f'site:grokipedia.com "{base}"',
                domain_type="web"
            )
            grok_url = search.results[0].url if search.results else None
            if grok_url:
                print(f"  Grokipedia URL: {grok_url}")
                fetch = client.fetch.get_contents(
                    urls=[grok_url],
                    format="markdown",
                    links=True,
                    image_links=True,
                )
                page = fetch.results[0] if fetch.results else None
                if page:
                    total_links = len(page.links) if hasattr(page, 'links') else 0
                    high_links = [l for l in (page.links or []) if is_high_value(l)]
                    print(f"  Grokipedia: {total_links} total links, {len(high_links)} high-value")
                    for link in high_links[:10]:
                        print(f"    → {link}")
                    if len(high_links) < 3:
                        print(f"  ⚠ LOW COVERAGE (<3 high-value) - will need Wikipedia + generic fallback")
                    else:
                        print(f"  ✓ OK - Grokipedia gives enough")
                else:
                    print(f"  Grokipedia fetch returned no results")
            else:
                print(f"  Grokipedia: no page found")
        except Exception as e:
            print(f"  Grokipedia error: {e}")

        # 2. Wikipedia search
        try:
            search = client.search.search(
                query=f'site:wikipedia.org "{base}" lake',
                domain_type="web"
            )
            wiki_url = search.results[0].url if search.results else None
            if wiki_url:
                print(f"  Wikipedia URL: {wiki_url}")
                fetch = client.fetch.get_contents(
                    urls=[wiki_url],
                    format="markdown",
                    links=True,
                    image_links=True,
                )
                page = fetch.results[0] if fetch.results else None
                if page:
                    total_links = len(page.links) if hasattr(page, 'links') else 0
                    high_links = [l for l in (page.links or []) if is_high_value(l)]
                    print(f"  Wikipedia: {total_links} total links, {len(high_links)} high-value")
                    for link in high_links[:10]:
                        print(f"    → {link}")
                    if len(high_links) < 2:
                        print(f"  ⚠ Wikipedia low coverage")
                    else:
                        print(f"  ✓ Wikipedia gives enough")
                else:
                    print(f"  Wikipedia fetch no results")
            else:
                print(f"  Wikipedia: no page found")
        except Exception as e:
            print(f"  Wikipedia error: {e}")

        # 3. Generic fallback count (simulate)
        print(f"  If both low, fallback to 3 generic searches: fishing report, water quality pdf, fisheries survey")

if __name__ == "__main__":
    main()
