import assert from "node:assert/strict";
import test from "node:test";
import { withPlaceOverlay } from "./place-overlay.mjs";

test("separate local tiles use inherited cartography, label collisions and no remote requests", () => {
  const style = { sources: { openmaptiles: { type: "vector", url: "pmtiles://{morocco}" } }, layers: [{ id: "poi_r1", type: "symbol", source: "openmaptiles", "source-layer": "poi", filter: ["==", "rank", 1], layout: { "icon-image": "icon", "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"] }, paint: { "text-color": "gray" } }] };
  const patched = withPlaceOverlay(style);
  assert.equal(patched.sources["linefleet-places"].url, "mbtiles://{places}");
  assert.equal(patched.layers[0].id, "poi_overture");
  assert.equal(patched.layers[0].layout["text-allow-overlap"], false);
  assert.equal(patched.layers[0].filter, undefined);
  assert.equal(patched.layers[0].layout["icon-image"], undefined);
  assert.deepEqual(patched.layers[0].paint, style.layers[0].paint);
  assert.deepEqual(withPlaceOverlay(patched), patched);
  assert.equal(style.sources["linefleet-places"], undefined);
});
