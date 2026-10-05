import gzip
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone

import mapbox_vector_tile

spec = importlib.util.spec_from_file_location("places", Path(__file__).with_name("build-places.py"))
places = importlib.util.module_from_spec(spec)
spec.loader.exec_module(places)
NOW = datetime(2026, 10, 5, tzinfo=timezone.utc)


def fixture(name="A landmark", lng=-7.62, lat=33.59, **changes):
    properties = {"names": {"primary": name}, "confidence": .99, "taxonomy": {"primary": "hospital"}, "addresses": [{"country": "MA"}], "sources": [{"license": "CDLA-Permissive-2.0", "update_time": "2026-09-14T00:00:00Z"}]}
    properties.update(changes)
    return {"id": name, "geometry": {"type": "Point", "coordinates": [lng, lat]}, "properties": properties}


class PlacesTests(unittest.TestCase):
    def test_rejects_stale_uncertain_closed_unlicensed_and_outside_places(self):
        candidates = [fixture(), fixture(confidence=.8), fixture(operating_status="permanently_closed"), fixture(sources=[{"license": "unknown"}]), fixture(sources=[{"license": "CC0", "update_time": "2023-01-01T00:00:00Z"}]), fixture(addresses=[{"country": "ES"}]), fixture(lng=10), fixture(taxonomy={})]
        self.assertEqual(len(places.select_places(candidates, NOW)), 1)

    def test_removes_nearby_alias_duplicate_without_removing_a_distant_branch(self):
        candidates = [fixture("Café Atlas"), fixture("Cafe Atlas", lng=-7.6201), fixture("Café Atlas", lng=-7.63)]
        self.assertEqual(len(places.select_places(candidates, NOW)), 2)

    def test_tiles_have_correct_tms_rows_and_decode_at_the_original_position(self):
        selected = places.select_places([fixture()], NOW)
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "places.mbtiles"
            self.assertEqual(places.build_tiles(selected, output, "2026-09-23.1"), 5)
            db = sqlite3.connect(output)
            z, x, row, data = db.execute("SELECT * FROM tiles WHERE zoom_level=16").fetchone()
            y = 2**z - 1 - row
            decoded = mapbox_vector_tile.decode(gzip.decompress(data), default_options={"y_coord_down": True})["poi"]["features"][0]
            dx, dy = decoded["geometry"]["coordinates"]
            self.assertAlmostEqual((x + dx/4096)/2**z, selected[0]["x"], places=7)
            self.assertAlmostEqual((y + dy/4096)/2**z, selected[0]["y"], places=7)
            self.assertEqual(decoded["properties"]["name"], "A landmark")
            self.assertIn("Overture", dict(db.execute("SELECT * FROM metadata"))["attribution"])
            db.close()


if __name__ == "__main__":
    unittest.main()
