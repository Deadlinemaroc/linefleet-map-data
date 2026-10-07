import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withWorldBase, WORLD_SOURCE, WORLD_LABELS_SOURCE } from "./world-base.mjs";
import { applyLinefleetMapDisplay } from "./map-display-policy.mjs";
import { curate, isExcluded } from "./build-world-labels.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const labels = JSON.parse(readFileSync(join(HERE, "world-country-labels.geojson"), "utf8"));
const NEEDLES = ["western sahara", "w. sahara", "sahara occidental", "sáhara occidental", "الصحراء الغربية"];

const liberty = () => ({
  version: 8,
  sources: { openmaptiles: { type: "vector", url: "pmtiles://{morocco}" } },
  layers: [
    { id: "background", type: "background", paint: { "background-color": "#f8f4f0" } },
    { id: "park", type: "fill", source: "openmaptiles", "source-layer": "park", paint: {} },
    { id: "landcover_ice", type: "fill", source: "openmaptiles", "source-layer": "landcover", filter: ["==", ["get", "class"], "ice"], paint: { "fill-color": "#e0ecec" } },
    { id: "water", type: "fill", source: "openmaptiles", "source-layer": "water", filter: ["!=", ["get", "brunnel"], "tunnel"], paint: { "fill-color": "rgb(158,189,255)" } },
    { id: "road", type: "line", source: "openmaptiles", "source-layer": "transportation", paint: {} },
    { id: "boundary_3", type: "line", source: "openmaptiles", "source-layer": "boundary", filter: [">=", ["get", "admin_level"], 3] },
    { id: "water_name_point_label", type: "symbol", source: "openmaptiles", "source-layer": "water_name", layout: { "text-field": "{name:latin}" } },
    { id: "label_country_3", type: "symbol", source: "openmaptiles", "source-layer": "place", minzoom: 2, maxzoom: 9, filter: ["all", ["==", ["get", "class"], "country"], [">=", ["get", "rank"], 3]], layout: { "text-field": "{name:latin}", "text-size": 10 } },
    { id: "label_country_2", type: "symbol", source: "openmaptiles", "source-layer": "place", maxzoom: 9, filter: ["all", ["==", ["get", "class"], "country"], ["==", ["get", "rank"], 2]], layout: { "text-field": "{name:latin}", "text-size": 12 } },
    { id: "label_country_1", type: "symbol", source: "openmaptiles", "source-layer": "place", maxzoom: 9, filter: ["all", ["==", ["get", "class"], "country"], ["==", ["get", "rank"], 1]], layout: { "text-field": "{name:latin}", "text-size": 14 } },
  ],
});

test("adds the world source and renders its fills right above the background, below national layers", () => {
  const style = withWorldBase(liberty(), labels);
  assert.equal(style.sources[WORLD_SOURCE].url, "pmtiles://{world}");
  assert.equal(style.sources[WORLD_LABELS_SOURCE].type, "geojson");
  const ids = style.layers.map((l) => l.id);
  assert.deepEqual(ids.slice(0, 4), ["background", "world_landcover_ice", "world_water", "park"]);
  const worldWater = style.layers.find((l) => l.id === "world_water");
  assert.equal(worldWater.source, WORLD_SOURCE);
  assert.equal(worldWater["source-layer"], "water");
  assert.deepEqual(worldWater.paint, { "fill-color": "rgb(158,189,255)" });
});

test("places world labels BEFORE the national ones so national labels win collisions", () => {
  const ids = withWorldBase(liberty(), labels).layers.map((l) => l.id);
  assert.ok(!ids.includes("world_water_name_point_label"), "no twin for a layer the world tileset lacks");
  assert.ok(ids.indexOf("world_label_country_1") < ids.indexOf("label_country_3"));
  assert.ok(ids.indexOf("world_label_country_national") < ids.indexOf("label_country_3"));
});

test("never clones a boundary layer: no country line can come from the world tiles", () => {
  const style = withWorldBase(liberty(), labels);
  assert.ok(style.layers.every((l) => !(l.source === WORLD_SOURCE && l["source-layer"] === "boundary")));
});

test("national label from the inline list only below zoom 2; other countries by rank tier", () => {
  const style = withWorldBase(liberty(), labels);
  const national = style.layers.find((l) => l.id === "world_label_country_national");
  assert.equal(national.maxzoom, 2);
  assert.equal(national.minzoom, undefined);
  assert.deepEqual(national.filter, ["==", ["get", "national"], true]);
  const tier1 = style.layers.find((l) => l.id === "world_label_country_1");
  assert.deepEqual(tier1.filter, ["all", ["==", ["get", "rank"], 1], ["!=", ["get", "national"], true]]);
  assert.equal(tier1["source-layer"], undefined);
});

test("is idempotent and leaves its input untouched", () => {
  const input = liberty();
  const before = structuredClone(input);
  const once = withWorldBase(input, labels);
  const twice = withWorldBase(once, labels);
  assert.deepEqual(twice, once);
  assert.deepEqual(input, before);
});

test("the display policy applied afterwards keeps every world layer and gives the clones the French-first label", () => {
  const style = applyLinefleetMapDisplay(withWorldBase(liberty(), labels));
  const ids = style.layers.map((l) => l.id);
  for (const id of ["world_landcover_ice", "world_water", "world_label_country_1", "world_label_country_2", "world_label_country_3", "world_label_country_national"]) {
    assert.ok(ids.includes(id), id);
  }
  const tier1 = style.layers.find((l) => l.id === "world_label_country_1");
  assert.equal(tier1.layout["text-field"][0], "let");
  // Belt and braces: the policy's territory exclusions also guard the inline label source.
  assert.ok(JSON.stringify(tier1.filter).includes("western sahara"));
  assert.ok(JSON.stringify(tier1.filter).includes("EH"));
});

test("curated labels: no excluded territory under any code or name, national flagged once", () => {
  const dump = JSON.stringify(labels).toLowerCase();
  for (const needle of NEEDLES) assert.ok(!dump.includes(needle), needle);
  assert.ok(labels.features.every((f) => f.properties.iso_a2 !== "EH" && f.properties.adm0_a3 !== "SAH"));
  const national = labels.features.filter((f) => f.properties.national === true);
  assert.equal(national.length, 1);
  assert.equal(national[0].properties["name:fr"], "Maroc");
  assert.ok(labels.features.length > 150);
});

test("curation excludes the territory by code and by every name, and tiers by LABELRANK", () => {
  assert.equal(isExcluded({ ADM0_A3: "SAH", NAME: "x" }), true);
  assert.equal(isExcluded({ ISO_A2: "EH", NAME: "x" }), true);
  assert.equal(isExcluded({ ADM0_A3: "XXX", NAME_FR: "Sahara occidental" }), true);
  assert.equal(isExcluded({ ADM0_A3: "XXX", NAME_AR: "الصحراء الغربية" }), true);
  assert.equal(isExcluded({ ADM0_A3: "ESP", NAME: "Spain" }), false);
  const out = curate({ features: [
    { properties: { ADM0_A3: "SAH", ISO_A2: "EH", NAME: "W. Sahara", LABEL_X: 1, LABEL_Y: 1, LABELRANK: 7 } },
    { properties: { ADM0_A3: "ESP", ISO_A2: "ES", NAME: "Spain", NAME_FR: "Espagne", NAME_AR: "إسبانيا", LABEL_X: -3.4, LABEL_Y: 40.1, LABELRANK: 2 } },
    { properties: { ADM0_A3: "MRT", ISO_A2: "MR", NAME: "Mauritania", NAME_FR: "Mauritanie", LABEL_X: -9.7, LABEL_Y: 19.6, LABELRANK: 3 } },
  ] });
  assert.deepEqual(out.features.map((f) => [f.properties.adm0_a3, f.properties.rank]), [["ESP", 1], ["MRT", 2]]);
});
