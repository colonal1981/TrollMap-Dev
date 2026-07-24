#!/usr/bin/env python3
"""
trollmap_r2_clean.py — Wipe TrollMap R2 data using Cloudflare API.

Requires: CF_ACCOUNT_ID and CF_API_TOKEN env vars (or hardcoded below).
Get API token from: https://dash.cloudflare.com/profile/api-tokens
  → Create Token → R2 Edit (read + write permissions)

Usage:
    py trollmap_r2_clean.py --list              # list objects in target prefixes
    py trollmap_r2_clean.py --dry-run --all     # count what would be deleted
    py trollmap_r2_clean.py --contours          # wipe contours/ prefix
    py trollmap_r2_clean.py --supplemental      # wipe supplemental/ prefix
    py trollmap_r2_clean.py --boundaries        # wipe boundaries/ prefix
    py trollmap_r2_clean.py --all               # wipe all three
"""

import os
import sys
import json
import argparse
import urllib.request
import urllib.parse

# ── Config — set these or export as env vars ──────────────────────────────────
CF_ACCOUNT_ID = os.environ.get('CF_ACCOUNT_ID', '')
CF_API_TOKEN  = os.environ.get('CF_API_TOKEN', '')
BUCKET        = 'trollmap-chartpacks'

WIPE_PREFIXES = {
    'contours':     'contours/',
    'supplemental': 'supplemental/',
    'boundaries':   'boundaries/',
}


def cf_request(method, path, params=None):
    """Make a Cloudflare API request. Returns parsed JSON."""
    base = f'https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/r2/buckets/{BUCKET}'
    url = base + path
    if params:
        url += '?' + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, method=method)
    req.add_header('Authorization', f'Bearer {CF_API_TOKEN}')
    req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='replace')
        print(f'  CF API error {e.code}: {body[:200]}')
        return None


def list_prefix(prefix, max_per_page=1000):
    """List all object keys under a prefix using CF R2 API."""
    keys = []
    cursor = None
    while True:
        params = {'prefix': prefix, 'per_page': max_per_page}
        if cursor:
            params['cursor'] = cursor
        data = cf_request('GET', '/objects', params)
        if not data or not data.get('success'):
            print(f'  CF API list failed: {data}')
            break
        result = data.get('result', {})
        if isinstance(result, list):
            objects = result
            truncated = False
            cursor = None
        else:
            objects = result.get('objects', [])
            truncated = result.get('truncated', False)
            cursor = result.get('cursor') if truncated else None
        for obj in objects:
            keys.append(obj['key'])
        if not cursor:
            break
    return keys


def delete_key(key):
    """Delete a single R2 object."""
    encoded = urllib.parse.quote(key, safe='')
    data = cf_request('DELETE', f'/objects/{encoded}')
    return data is not None and data.get('success', False)


def wipe_prefix(prefix_name, dry_run=False, list_only=False):
    prefix = WIPE_PREFIXES[prefix_name]
    print(f'\n{"─"*60}')
    print(f'Scanning {prefix} ...')
    keys = list_prefix(prefix)
    print(f'Found {len(keys)} objects')

    if list_only:
        for k in keys[:50]:
            print(f'  {k}')
        if len(keys) > 50:
            print(f'  ... and {len(keys)-50} more')
        return len(keys)

    if not keys:
        print('  Nothing to delete.')
        return 0

    if dry_run:
        print(f'  DRY RUN: would delete {len(keys)} objects')
        for k in keys[:20]:
            print(f'    {k}')
        if len(keys) > 20:
            print(f'    ... and {len(keys)-20} more')
        return len(keys)

    print(f'Deleting {len(keys)} objects...')
    ok = fail = 0
    for i, key in enumerate(keys):
        if delete_key(key):
            ok += 1
        else:
            print(f'  FAILED: {key}')
            fail += 1
        if (i+1) % 25 == 0:
            print(f'  {i+1}/{len(keys)} ({ok} ok, {fail} failed)')

    print(f'Done: {ok} deleted, {fail} failed')
    return ok


def check_credentials():
    if not CF_ACCOUNT_ID or not CF_API_TOKEN:
        print('ERROR: CF_ACCOUNT_ID and CF_API_TOKEN must be set.')
        print()
        print('Get your Account ID from: https://dash.cloudflare.com → R2 → Overview (right sidebar)')
        print('Get/create API token from: https://dash.cloudflare.com/profile/api-tokens')
        print('  → Create Token → R2 Edit (needs Read + Write on R2)')
        print()
        print('Then either:')
        print('  set CF_ACCOUNT_ID=your_account_id')
        print('  set CF_API_TOKEN=your_token')
        print('Or hardcode them at the top of this script.')
        sys.exit(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--all',           action='store_true')
    ap.add_argument('--contours',      action='store_true')
    ap.add_argument('--supplemental',  action='store_true')
    ap.add_argument('--boundaries',    action='store_true')
    ap.add_argument('--dry-run',       action='store_true')
    ap.add_argument('--list',          action='store_true')
    args = ap.parse_args()

    check_credentials()

    if args.all:
        args.contours = args.supplemental = args.boundaries = True

    if not any([args.all, args.contours, args.supplemental, args.boundaries, args.list]):
        ap.print_help()
        print('\nSpecify at least one of: --all --contours --supplemental --boundaries --list')
        sys.exit(1)

    targets = []
    if args.contours:     targets.append('contours')
    if args.supplemental: targets.append('supplemental')
    if args.boundaries:   targets.append('boundaries')

    if args.list:
        for t in ['contours', 'supplemental', 'boundaries']:
            wipe_prefix(t, list_only=True)
        return

    if args.dry_run:
        print('DRY RUN — nothing will be deleted')
    else:
        print(f'Targets: {", ".join(targets)}')
        print(f'Bucket:  {BUCKET}')
        confirm = input('\nType YES to confirm deletion: ')
        if confirm.strip() != 'YES':
            print('Aborted.')
            sys.exit(0)

    total = 0
    for t in targets:
        total += wipe_prefix(t, dry_run=args.dry_run)

    print(f'\n{"─"*60}')
    print(f'Total: {total} objects {"would be " if args.dry_run else ""}deleted')


if __name__ == '__main__':
    main()
