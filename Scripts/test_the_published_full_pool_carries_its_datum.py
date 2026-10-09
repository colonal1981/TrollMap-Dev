#!/usr/bin/env python3
"""test_the_published_full_pool_carries_its_datum.py

Personal use only, not for distribution or resale; not for navigation.

chartDatumShape() in Worker/conditions.js subtracts a gauge's level from the registry's full pool
only when both name the same vertical datum. slim_full_pool() decides what of
registry/full_pool.json reaches R2, and it never published `datum` -- so no row could ever earn
the difference that way, and Lake Marion's card said "measured from different marks" over a 76.8
and a 72.78 that are both on NGVD29 (2026-10-08).

    py Scripts\\test_the_published_full_pool_carries_its_datum.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import upload_garmin_to_r2 as ug  # noqa: E402

DOC = {'_note': 'n', 'read': '2026-10-08', 'datum_rule': {'statement': 'max of the target'}, 'rows': {
    'lake_marion': {'full_pool_ft': 76.8, 'units': 'ft above sea level', 'source': 'Santee Cooper',
                    'full_pool_status': 'RESOLVED', 'datum': 'NGVD29', 'reading_ft': 74.02},
    'lake_moultrie': {'full_pool_ft': 75.5, 'source': 'Santee Cooper via LMIS1 and PINS1',
                      'full_pool_status': 'RESOLVED'},
}}


def test_a_stated_datum_is_published():
    rows = ug.slim_full_pool(DOC, {})['rows']
    assert rows['lake_marion']['datum'] == 'NGVD29'
    assert rows['lake_marion']['full_pool_ft'] == 76.8
    assert rows['lake_marion']['status'] == 'RESOLVED'


def test_a_row_with_no_datum_says_none():
    row = ug.slim_full_pool(DOC, {})['rows']['lake_moultrie']
    assert 'datum' not in row, 'an unstated datum must stay unstated, not become an empty string'
    assert 'reading_ft' not in ug.slim_full_pool(DOC, {})['rows']['lake_marion'], 'working notes stay home'


if __name__ == '__main__':
    test_a_stated_datum_is_published()
    test_a_row_with_no_datum_says_none()
    print('ok: the published full pool carries the datum the Worker compares the gauge against')
