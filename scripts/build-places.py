#!/usr/bin/env python3
"""Regional, independently licensed POI tiles; never geocode vehicles with them.

Run on the build host, not the VPS. The CLI downloads only the selected region.
Only recent, named, high-confidence records with accepted permissive licenses
are included. A country attribute prevents nearby Canary/Algerian places leaking
into this regional overlay. This is not a national-boundary representation.
"""
import argparse
from collections import defaultdict
from datetime import datetime, timezone
import gzip
import json
import math
from pathlib import Path
import sqlite3
import subprocess
import unicodedata
import urllib.request

import mapbox_vector_tile

ALLOWED_LICENSES = {"CDLA-Permissive-2.0", "CC0-1.0", "CC0"}
BOUNDS = (-17.2, 20.75, -0.95, 36.1)


def normalized_name(name):
    return "".join(c for c in unicodedata.normalize("NFKD", name).casefold() if c.isalnum())


def project(lng, lat):
    return (lng + 180) / 360, (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2


def select_places(features, now):
    selected = []
    nearby = defaultdict(list)
    for feature in sorted(features, key=lambda f: f["properties"].get("confidence") or 0, reverse=True):
        p = feature["properties"]
        geometry = feature.get("geometry") or {}
        if geometry.get("type") != "Point":
            continue
        lng, lat = geometry["coordinates"][:2]
        if not (BOUNDS[0] <= lng <= BOUNDS[2] and BOUNDS[1] <= lat <= BOUNDS[3]):
            continue
        if (p.get("confidence") or 0) < .95 or p.get("operating_status") in {"permanently_closed", "closed"}:
            continue
        if not any(a.get("country") in {"MA", "EH"} for a in p.get("addresses") or []):
            continue
        name = (p.get("names") or {}).get("primary", "").strip()
        category = (p.get("taxonomy") or {}).get("primary")
        sources = p.get("sources") or []
        if not name or len(name) > 120 or "http" in name.lower() or not category or not sources:
            continue
        if any(s.get("license") not in ALLOWED_LICENSES for s in sources):
            continue
        dates = []
        for source in sources:
            if source.get("update_time"):
                dates.append(datetime.fromisoformat(source["update_time"].replace("Z", "+00:00")))
        if not dates or (now - max(dates)).days > 365:
            continue
        # Remove same-name duplicates within ~75m; retain different branches.
        x, y = project(lng, lat)
        mx, my = x * 40_075_016.686, y * 40_075_016.686
        cell = (int(mx // 100), int(my // 100))
        key = normalized_name(name)
        duplicate = any(
            other[2] == key and math.hypot(mx - other[0], my - other[1]) * math.cos(math.radians(lat)) < 75
            for dx in (-1, 0, 1) for dy in (-1, 0, 1)
            for other in nearby[(cell[0] + dx, cell[1] + dy)]
        )
        if duplicate:
            continue
        nearby[cell].append((mx, my, key))
        selected.append({"id": feature.get("id"), "x": x, "y": y, "properties": {
            "name": name, "category": category, "confidence": p["confidence"],
            "source": "Overture", "updated": max(dates).date().isoformat(),
        }, "sources": sources})
    return selected


def build_tiles(places, output, release):
    output.unlink(missing_ok=True)
    db = sqlite3.connect(output)
    db.executescript("CREATE TABLE metadata(name TEXT PRIMARY KEY,value TEXT); CREATE TABLE tiles(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB,PRIMARY KEY(zoom_level,tile_column,tile_row));")
    metadata = {"name": "Linefleet nearby places", "format": "pbf", "type": "overlay", "version": "1", "minzoom": "12", "maxzoom": "16", "bounds": ",".join(map(str, BOUNDS)), "attribution": "© Overture Maps Foundation · Meta / Microsoft / AllThePlaces", "json": json.dumps({"vector_layers": [{"id": "poi", "minzoom": 12, "maxzoom": 16, "fields": {"name": "String", "category": "String", "confidence": "Number", "source": "String", "updated": "String"}}]}), "overture_release": release}
    db.executemany("INSERT INTO metadata VALUES (?,?)", metadata.items())
    tile_count = 0
    for zoom in range(12, 17):
        tiles = defaultdict(list)
        scale = 2 ** zoom
        for place in places:
            x, y = int(place["x"] * scale), int(place["y"] * scale)
            tiles[(x, y)].append({"geometry": {"type": "Point", "coordinates": [(place["x"] * scale - x) * 4096, (place["y"] * scale - y) * 4096]}, "properties": place["properties"]})
        for (x, y), features in tiles.items():
            encoded = mapbox_vector_tile.encode({"name": "poi", "features": features}, default_options={"y_coord_down": True, "extents": 4096})
            db.execute("INSERT INTO tiles VALUES (?,?,?,?)", (zoom, x, scale - 1 - y, gzip.compress(encoded, mtime=0)))
            tile_count += 1
    db.commit()
    db.close()
    return tile_count


def main():
    args = argparse.ArgumentParser()
    args.add_argument("--input", type=Path)
    args.add_argument("--release")
    args.add_argument("--work-dir", type=Path, required=True)
    options = args.parse_args()
    work = options.work_dir
    work.mkdir(parents=True, exist_ok=True)
    release = options.release
    if not release:
        with urllib.request.urlopen("https://stac.overturemaps.org/catalog.json", timeout=30) as response:
            release = json.load(response)["latest"]
    if (datetime.now(timezone.utc).date() - datetime.fromisoformat(release.split(".")[0]).date()).days > 60:
        raise ValueError("Overture release is stale; refusing to publish")
    source = options.input or work / "places.geojson"
    if not options.input:
        subprocess.run(["overturemaps", "download", "--bbox=" + ",".join(map(str, BOUNDS)), "--release=" + release, "-f", "geojson", "--type=place", "-o", str(source)], check=True, timeout=1200)
    data = json.loads(source.read_text())
    places = select_places(data["features"], datetime.now(timezone.utc))
    if not 500 <= len(places) <= 50_000:
        raise ValueError(f"Unexpected regional place count: {len(places)}")
    tiles = build_tiles(places, work / "places.mbtiles", release)
    metadata = {"release": release, "places": len(places), "tiles": tiles, "minimumConfidence": .95, "licenses": sorted({s["license"] for p in places for s in p["sources"]})}
    (work / "places-metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    # Preserve source provenance outside compact runtime tiles.
    (work / "places-provenance.json").write_text(json.dumps([{ "id": p["id"], "name": p["properties"]["name"], "sources": p["sources"] } for p in places], ensure_ascii=False))
    with urllib.request.urlopen("https://cdla.dev/permissive-2-0/", timeout=30) as response:
        (work / "places-CDLA-Permissive-2.0.html").write_bytes(response.read())
    print(json.dumps(metadata))


if __name__ == "__main__":
    main()
