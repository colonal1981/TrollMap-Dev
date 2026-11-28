"""The audit's depth-gap comparison. Personal use only, not for distribution or resale; not for navigation.

    py .\\test_audit_depth_gap.py
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from audit_packs import compare


def pack(gap):
    return {'layers': {}, 'depth': {'gap_ft': gap}}


def test_a_band_still_past_the_contour_is_not_behind():
    # The Pigeon after its boundary reached the lake: 7 ft -> 62 ft deep, the band a foot past both times.
    reg, imp = compare({'pigeon_river': pack(-1.1)}, {'pigeon_river': pack(-1.0)}, 0.5)
    assert reg == [] and imp == []


def test_a_band_short_of_the_contour_still_fails():
    # The page-bit bug: bands capped at 83 ft under a 348 ft contour.
    reg, _ = compare({'jocassee': pack(-12.0)}, {'jocassee': pack(265.0)}, 0.5)
    assert len(reg) == 1 and 'fell further behind' in reg[0]
    reg, imp = compare({'jocassee': pack(265.0)}, {'jocassee': pack(-12.0)}, 0.5)
    assert reg == [] and len(imp) == 1


if __name__ == '__main__':
    for name, fn in sorted(globals().items()):
        if name.startswith('test_') and callable(fn):
            fn(); print('ok  ' + name)
