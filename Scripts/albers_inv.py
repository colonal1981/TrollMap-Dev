"""Inverse of lookup_3dhp.albers -- EPSG:6350 metres back to WGS84 lon/lat.

lookup_3dhp only ships the forward projection, so anything read out of the GeoPackage in metres
(a feature envelope, say) could be projected INTO Albers for comparison but never back out. That
forced every locality test to convert the other side instead -- millions of registry vertices and
depth cells -- when inverting one point per feature is the cheap direction.

Newton on the authalic-latitude relation; the forward q() is reused so the two cannot drift.
"""
import math

_A = 6378137.0
_F = 1 / 298.257222101
_E2 = 2 * _F - _F * _F
_E = math.sqrt(_E2)


def _q(p):
    s = math.sin(p)
    return (1 - _E2) * (s / (1 - _E2 * s * s)
                        - (1 / (2 * _E)) * math.log((1 - _E * s) / (1 + _E * s)))


def _m(p):
    s = math.sin(p)
    return math.cos(p) / math.sqrt(1 - _E2 * s * s)


_P1, _P2, _P0 = map(math.radians, (29.5, 45.5, 23.0))
_L0 = math.radians(-96.0)
_N = (_m(_P1) ** 2 - _m(_P2) ** 2) / (_q(_P2) - _q(_P1))
_C = _m(_P1) ** 2 + _N * _q(_P1)
_RHO0 = _A * math.sqrt(_C - _N * _q(_P0)) / _N


def inv(x, y):
    """EPSG:6350 metres -> (lon, lat) in degrees."""
    rho = math.hypot(x, _RHO0 - y)
    theta = math.atan2(x, _RHO0 - y)
    lon = math.degrees(_L0 + theta / _N)
    q = (_C - (rho * _N / _A) ** 2) / _N
    p = math.asin(max(-1.0, min(1.0, q / 2.0)))
    for _ in range(12):
        s = math.sin(p)
        d = (1 - _E2 * s * s) ** 2 / (2 * math.cos(p)) * (q - _q(p)) / (1 - _E2)
        p += d
        if abs(d) < 1e-12:
            break
    return lon, math.degrees(p)
