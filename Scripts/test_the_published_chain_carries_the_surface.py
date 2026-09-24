#!/usr/bin/env python3
"""test_the_published_chain_carries_the_surface.py

Personal use only, not for distribution or resale; not for navigation.

The Worker's clarity model divides each lake's drainage by its surface to rank how fast it stains
(Worker/clarity-sensitivity.js). slim_chain() decides what of registry/water_chain.json reaches
R2, and it published the drainage without the surface -- so the Worker would have computed the
ratio from a field that was never there, and every lake would have fallen back to the generic
rates without an error anywhere.

    py Scripts\\test_the_published_chain_carries_the_surface.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import upload_garmin_to_r2 as ug  # noqa: E402

FULL = {'_meta': {'source': 'NHDPlus HR'}, 'waters': {
    'wateree_lake': {'drainage_km2': 12256.6, 'local_drainage_km2': 12256.6, 'nhd_area_km2': 47.58,
                     'nhd_ftype': 390, 'upstream': ['cedar_creek_reservoir_2'], 'downstream': 'wateree_river'},
    'congaree_river': {'drainage_km2': 20000.0, 'nhd_area_km2': 9.9, 'nhd_ftype': 460},
}}


def test_surface_and_type_are_published():
    w = ug.slim_chain(FULL)['waters']
    assert w['wateree_lake']['nhd_area_km2'] == 47.58
    assert w['wateree_lake']['drainage_km2'] == 12256.6
    assert w['wateree_lake']['nhd_ftype'] == 390
    assert w['congaree_river']['nhd_ftype'] == 460, 'a river must still read as a river'


def test_what_was_already_published_is_unchanged():
    w = ug.slim_chain(FULL)['waters']['wateree_lake']
    assert w['upstream'] == ['cedar_creek_reservoir_2']
    assert w['outlets'] == ['wateree_river']
    assert w['side_channel'] is False
    assert w['routed_drainage_km2'] == 12256.6


if __name__ == '__main__':
    test_surface_and_type_are_published()
    test_what_was_already_published_is_unchanged()
    print('ok: the published chain carries the surface the clarity ranking divides by')
