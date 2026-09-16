#!/usr/bin/env python3
"""
convert_hotspots_to_geojson.py — Converts tristate_hotspot.json array to GeoJSON.
Drop this in the same folder as tristate_hotspot.json and run it.
"""
import json
from pathlib import Path

INPUT  = Path(r'F:\TrollMapPipeline\tristate_hotspot.json')
OUTPUT = Path(r'F:\TrollMapPipeline\tristate_hotspot.geojson')

with open(INPUT, 'r', encoding='utf-8') as f:
    data = json.load(f)

features = []
for item in data:
    lat = item.get('lat')
    lon = item.get('lon')
    if lat is None or lon is None:
        continue
    features.append({
        'type': 'Feature',
        'geometry': {'type': 'Point', 'coordinates': [lon, lat]},
        'properties': {k: v for k, v in item.items() if k not in ('lat', 'lon')}
    })

geojson = {'type': 'FeatureCollection', 'features': features}

with open(OUTPUT, 'w', encoding='utf-8') as f:
    json.dump(geojson, f, separators=(',', ':'))

print(f"Done: {len(features)} features -> {OUTPUT}")
