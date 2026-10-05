import assert from "node:assert/strict";
import test from "node:test";
import { applyLinefleetMapDisplay } from "./map-display-policy.mjs";

const boundary = (id, filter) => ({ id, type: "line", source: "openmaptiles", "source-layer": "boundary", filter });
const base = (layers) => ({ version: 8, sources: { openmaptiles: { type: "vector", url: "pmtiles://{morocco}" } }, layers });

test("removes old national geometry and every referencing layer without mutating input", () => {
  const source = base([
    { id: "ma-outline", type: "line", source: "ma-unified" },
    { id: "old-outline-casing", type: "line", source: "ma-unified" },
    { id: "ma-outline", type: "line", source: "another-source" },
    { id: "road", type: "line", source: "openmaptiles", "source-layer": "transportation" },
  ]);
  source.sources["ma-unified"] = { type: "geojson", data: { type: "FeatureCollection", features: [] } };
  const before = structuredClone(source);
  const patched = applyLinefleetMapDisplay(source);
  assert.equal(patched.sources["ma-unified"], undefined);
  assert.deepEqual(patched.layers.map((layer) => layer.id), ["road"]);
  assert.deepEqual(source, before);
});

test("removes country/disputed layers and restricts mixed boundary layers to internal levels", () => {
  const patched = applyLinefleetMapDisplay(base([
    boundary("boundary_2"),
    boundary("country-renamed", ["all", ["==", ["get", "admin_level"], 2]]),
    boundary("country-legacy", ["==", "admin_level", 2]),
    boundary("boundary_disputed"),
    boundary("dispute-renamed", ["==", ["get", "disputed"], 1]),
    boundary("regions", ["all", [">=", ["get", "admin_level"], 3]]),
    boundary("mixed", ["all", [">=", "admin_level", 2]]),
  ]));
  assert.deepEqual(patched.layers.map((layer) => layer.id), ["regions", "mixed"]);
  assert.ok(patched.layers[0].filter.some((clause) => JSON.stringify(clause) === JSON.stringify([">", ["get", "admin_level"], 2])));
  assert.ok(patched.layers[1].filter.some((clause) => JSON.stringify(clause) === JSON.stringify([">", "admin_level", 2])));
  assert.ok(patched.layers[0].filter.some((clause) => JSON.stringify(clause) === JSON.stringify(["!=", ["get", "disputed"], 1])));
});

test("retains road/city data while applying place-label exclusions in both filter syntaxes", () => {
  const road = { id: "road", type: "line", source: "openmaptiles", "source-layer": "transportation", paint: { "line-width": 2 } };
  const city = { id: "cities", type: "symbol", source: "openmaptiles", "source-layer": "place", filter: ["==", ["get", "class"], "city"], layout: { "text-field": ["get", "name"] } };
  const legacy = { ...city, id: "legacy-cities", filter: ["==", "class", "city"] };
  const patched = applyLinefleetMapDisplay(base([road, city, legacy]));
  assert.deepEqual(patched.layers[0], road);
  assert.match(JSON.stringify(patched.layers[1].layout["text-field"]), /name:fr/);
  assert.deepEqual(patched.layers[1].filter[1], city.filter);
  assert.ok(patched.layers[1].filter.some((clause) => JSON.stringify(clause) === JSON.stringify(["!=", ["get", "iso_a2"], "EH"])));
  assert.ok(patched.layers[2].filter.some((clause) => JSON.stringify(clause) === JSON.stringify(["!=", "iso_a2", "EH"])));
  assert.match(JSON.stringify(patched.layers[1].filter), /western sahara/);
  assert.match(JSON.stringify(patched.layers[1].filter), /الصحراءالغربية/);
});

test("is idempotent for already-patched styles", () => {
  const first = applyLinefleetMapDisplay(base([
    boundary("regions", [">", ["get", "admin_level"], 2]),
    { id: "places", type: "symbol", source: "openmaptiles", "source-layer": "place" },
  ]));
  assert.deepEqual(applyLinefleetMapDisplay(first), first);
});

test("reveals useful places earlier with bilingual fallback and normal collision handling", () => {
  const source = base([{ id: "poi_r1", type: "symbol", "source-layer": "poi", minzoom: 15, layout: { "text-field": ["get", "name"], "text-allow-overlap": false } }]);
  const patched = applyLinefleetMapDisplay(source);
  assert.equal(patched.layers[0].minzoom, 14);
  assert.match(JSON.stringify(patched.layers[0].layout["text-field"]), /name:ar/);
  assert.equal(patched.layers[0].layout["text-allow-overlap"], false);
  assert.deepEqual(applyLinefleetMapDisplay(patched), patched);
});


test("a missing upstream sprite gets a bundled fallback without hiding place names", () => {
  const icon = ["get", "class"];
  const source = base([{ id: "poi_r1", type: "symbol", "source-layer": "poi", layout: { "icon-image": icon, "text-field": ["get", "name"] } }]);
  const patched = applyLinefleetMapDisplay(source);
  assert.deepEqual(patched.layers[0].layout["icon-image"], ["coalesce", ["image", icon], ["image", "circle_11"]]);
  assert.equal(patched.layers[0].layout["icon-optional"], true);
  assert.deepEqual(applyLinefleetMapDisplay(patched), patched);
  assert.deepEqual(source.layers[0].layout["icon-image"], icon);
});
