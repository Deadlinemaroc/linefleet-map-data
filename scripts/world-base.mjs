/**
 * World base for the national Liberty styles.
 *
 * The national tileset covers the country only; beyond it the server has no
 * tiles and MapLibre paints the land-coloured background. This adds a second
 * vector source — `world`, a Natural Earth / OSM-water-polygon tileset at
 * zooms 0–7 built by build-world-pmtiles.sh — and clones the few base layers
 * it needs (ice, water) so the planet renders under the national detail. The
 * world tileset carries no `water_name` layer, so ocean names are not cloned. No boundary layer is cloned: the policy draws no country
 * line from tiles anywhere, so nothing can show a separation inside the
 * national territory. Country names come from a curated inline list
 * (world-country-labels.geojson, build-world-labels.mjs) — the national label
 * keeps coming from the national tiles from zoom 2; the inline list carries
 * it only below that.
 *
 * Idempotent and side-effect free; run BEFORE applyLinefleetMapDisplay so the
 * label text-field and exclusions also apply to the clones.
 */

export const WORLD_SOURCE = "world";
export const WORLD_LABELS_SOURCE = "world-country-labels";
export const WORLD_SOURCE_URL = "pmtiles://{world}"; // config.json data id "world"

/** The national-source layers that get a world twin, in render order. */
const BASE_TWINS = ["landcover_ice", "water"];
const COUNTRY_LABEL_LAYERS = ["label_country_1", "label_country_2", "label_country_3"];

function clone(layer, id, source) {
  const twin = structuredClone(layer);
  twin.id = id;
  twin.source = source;
  return twin;
}

export function withWorldBase(input, labels) {
  const style = structuredClone(input);
  if (!style?.sources || !Array.isArray(style.layers)) return style;
  if (style.sources[WORLD_SOURCE]) return style;
  if (!labels || labels.type !== "FeatureCollection" || !Array.isArray(labels.features)) {
    throw new Error("withWorldBase needs the curated world-country-labels FeatureCollection");
  }

  style.sources[WORLD_SOURCE] = { type: "vector", url: WORLD_SOURCE_URL };
  style.sources[WORLD_LABELS_SOURCE] = { type: "geojson", data: labels };

  const layers = style.layers;
  const byId = (id) => layers.find((layer) => layer.id === id);

  // Base fills right above the background, below every national layer.
  const background = layers.findIndex((layer) => layer.type === "background");
  let insertAt = background + 1;
  for (const id of BASE_TWINS) {
    const template = byId(id);
    if (!template) continue;
    const twin = clone(template, `world_${id}`, WORLD_SOURCE);
    twin.maxzoom = 22; // z7 tiles are overzoomed beyond the national coverage
    layers.splice(insertAt, 0, twin);
    insertAt += 1;
  }

  // Country names: three rank tiers cloned from the national country layers,
  // reading the curated inline points instead of the `place` source-layer.
  const firstCountry = layers.find((layer) => COUNTRY_LABEL_LAYERS.includes(layer.id));
  if (firstCountry) {
    const at = layers.indexOf(firstCountry);
    const twins = [];
    for (const [index, id] of COUNTRY_LABEL_LAYERS.entries()) {
      const template = byId(id);
      if (!template) continue;
      const twin = clone(template, `world_${id}`, WORLD_LABELS_SOURCE);
      delete twin["source-layer"];
      twin.filter = ["all", ["==", ["get", "rank"], index + 1], ["!=", ["get", "national"], true]];
      twins.push(twin);
    }
    // The national label below zoom 2 only; the national tiles carry it after.
    const nationalTemplate = byId("label_country_2") ?? byId("label_country_1");
    if (nationalTemplate) {
      const twin = clone(nationalTemplate, "world_label_country_national", WORLD_LABELS_SOURCE);
      delete twin["source-layer"];
      delete twin.minzoom;
      twin.maxzoom = 2;
      twin.filter = ["==", ["get", "national"], true];
      twins.push(twin);
    }
    layers.splice(at, 0, ...twins);
  }
  return style;
}
