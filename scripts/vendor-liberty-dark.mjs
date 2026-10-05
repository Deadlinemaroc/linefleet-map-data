#!/usr/bin/env node
//
// vendor-liberty-dark.mjs — DARK-theme sibling of vendor-liberty-style.mjs.
// Produces a professional "control-room" DARK MapLibre style over the SAME
// self-hosted pmtiles the light Liberty build serves, published at
//   assets/styles/liberty-dark.json
// and served by the tileserver-gl sidecar at /styles/liberty-dark/style.json (the URL id comes from the config KEY, not the file path)
// (→ VITE_MAP_STYLE_DARK_URL, the `Mode sombre` basemap preset, §map-providers).
//
// Run ONCE on a dev/build machine (Node 18+; project ships Node 24), from the
// docker/tiles/ directory, AFTER (or alongside) the light build — this reuses
// the light build's fonts + sprite, so it does NOT re-download either:
//
//   node ./vendor-liberty-dark.mjs
//
// Local/offline source override (mirrors STYLE_URL/OFM_BASE): point the base
// style at a local JSON file instead of the network (CI / air-gapped build):
//
//   STYLE_FILE=./some-raw-liberty-style.json node ./vendor-liberty-dark.mjs
//
// What it does (same seam as the light build, then a dark repaint):
//   1. Loads the RESOLVED base Liberty style JSON (from STYLE_URL/OFM, or a
//      local STYLE_FILE) — the SAME base the light build vendors.
//   2. REWRITES sources/glyphs/sprite to tileserver-gl LOCAL paths, IDENTICALLY
//      to the light build:
//        - vector source "openmaptiles" -> "pmtiles://{morocco}"
//        - glyphs -> "{fontstack}/{range}.pbf"   (paths-relative — the
//          paths-doubling gotcha; tileserver-gl prepends paths.fonts)
//        - sprite -> "liberty"  (paths-relative; the dark build REUSES the
//          light sprite — no dark sprite is generated)
//      and DROPS remote raster sources (e.g. ne2_shaded) + their layers.
//   3. Applies the same Linefleet map display policy as the light build:
//      removes country/disputed layers and previous custom national outlines,
//      keeps regional layers, and excludes selected place labels.
//   4. Applies `darkenColors(style)` — repaints the base cartography layers to
//      a cohesive dark ramp (see the DARK ramp below).
//   5. Sets `name = "liberty-dark"` and writes styles/liberty-dark.json.
//   6. FAILS LOUDLY if any URL-like remnant survives (offline guarantee) —
//      same check as the light build.
//
// This does NOT wipe assets/ (that would delete the light build's fonts/sprite)
// and does NOT download fonts/sprites — it only emits the dark style JSON.
//
// Outputs (git-ignored — regenerate at deploy time; see .gitignore):
//   assets/styles/liberty-dark.json
//
// NOTE: the networked path makes ONE-TIME calls to OpenFreeMap. It was NOT run
// in the authoring sandbox (egress blocked). Run it on a networked build
// machine, or feed a local base via STYLE_FILE.

import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withPlaceOverlay } from "./place-overlay.mjs";
import { applyLinefleetMapDisplay } from "./map-display-policy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(HERE, "..", "assets");

const OFM_BASE = (process.env.OFM_BASE ?? "https://tiles.openfreemap.org").replace(/\/+$/, "");
const STYLE_URL = process.env.STYLE_URL ?? `${OFM_BASE}/styles/liberty`;
// Optional local base-style source (offline / CI). When set, read+parse this
// file instead of fetching STYLE_URL — must be a RAW resolved Liberty style.
const STYLE_FILE = process.env.STYLE_FILE ?? "";

// Local rewrite targets — MUST match the light build (config.json paths + the
// shared sprite/font layout). Values are paths-RELATIVE (the paths-doubling
// gotcha: tileserver-gl prepends paths.sprites/paths.fonts, so the style value
// must NOT repeat the directory segment).
const LOCAL_SOURCE_URL = "pmtiles://{morocco}"; // config.json data id "morocco"
const LOCAL_GLYPHS = "{fontstack}/{range}.pbf";
const LOCAL_SPRITE = "liberty"; // reuse the light sprite (no dark sprite emitted)

// ---------------------------------------------------------------------------
function log(...a) { console.log("==>", ...a); }
function die(msg) { console.error("\nERROR:", msg); process.exit(1); }

async function fetchOrThrow(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res;
}

async function writeFileEnsured(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

// ===========================================================================
// darkenColors — repaint the base cartography to a cohesive control-room dark.
//
// Professional dark theme (NOT pure black): a very dark desaturated blue-grey
// base, water a touch bluer, buildings a touch lighter, mid-grey roads with a
// warm motorway hint, light text on a dark halo. Data-driven color expressions
// are replaced with the flat dark color (acceptable for this theme); opacity /
// width expressions are left intact. Runs AFTER applyLinefleetMapDisplay.
// ===========================================================================

const DARK = {
  base: "hsl(220, 18%, 12%)",       // background + land + default fills
  landuse: "hsl(220, 16%, 15%)",    // landcover / landuse / parks — a touch lighter
  water: "hsl(220, 30%, 16%)",
  building: "hsl(220, 12%, 18%)",
  road: "hsl(220, 10%, 32%)",       // mid grey
  roadCasing: "hsl(220, 14%, 20%)", // darker than the road → outlined look
  motorway: "hsl(40, 30%, 45%)",    // slightly brighter, warm highway hint
  text: "hsl(0, 0%, 85%)",
  textHalo: "hsl(220, 20%, 10%)",
  boundary: "hsl(220, 10%, 35%)",   // internal region boundaries (boundary_3)
};

/** Pick a fill color by the layer's OpenMapTiles source-layer / id role. */
function fillColorFor(layer) {
  const sl = layer["source-layer"];
  const id = String(layer.id ?? "");
  if (sl === "water" || /(^|[-_])water([-_]|$)|ocean|sea|bay/i.test(id)) return DARK.water;
  if (sl === "building" || /building/i.test(id)) return DARK.building;
  if (
    sl === "landcover" || sl === "landuse" || sl === "park" || sl === "aeroway" ||
    /landcover|landuse|park|wood|forest|grass|scrub|wetland|cemetery|pitch|sand|rock|glacier|golf|hospital|school|residential|industrial|pedestrian|aeroway/i.test(id)
  ) {
    return DARK.landuse;
  }
  return DARK.base;
}

/** Pick a line color by role — water > boundary > casing > motorway > road. */
function lineColorFor(layer) {
  const sl = layer["source-layer"];
  const id = String(layer.id ?? "");
  if (sl === "waterway" || /waterway|river|stream|canal|water/i.test(id)) return DARK.water;
  if (sl === "boundary" || /boundary|admin/i.test(id)) return DARK.boundary;
  if (/casing/i.test(id)) return DARK.roadCasing;
  if (/motorway|trunk|highway-motorway/i.test(id)) return DARK.motorway;
  return DARK.road; // transportation + any remaining line family
}

function darkenColors(style) {
  const dark = structuredClone(style);
  if (!Array.isArray(dark.layers)) return dark;
  let bg = 0, fills = 0, lines = 0, symbols = 0, extrusions = 0;
  for (const layer of dark.layers) {
    if (typeof layer !== "object" || layer === null) continue;
    const paint = (layer.paint = layer.paint ?? {});
    switch (layer.type) {
      case "background":
        paint["background-color"] = DARK.base;
        delete paint["background-pattern"]; // light-sprite pattern would clash
        bg++;
        break;
      case "fill":
        paint["fill-color"] = fillColorFor(layer);
        delete paint["fill-pattern"];         // patterns are light-sprite art
        delete paint["fill-outline-color"];   // no light hairline on dark fills
        fills++;
        break;
      case "fill-extrusion":
        paint["fill-extrusion-color"] = DARK.building;
        extrusions++;
        break;
      case "line":
        paint["line-color"] = lineColorFor(layer);
        lines++;
        break;
      case "symbol": {
        paint["text-color"] = DARK.text;
        paint["text-halo-color"] = DARK.textHalo;
        const w = paint["text-halo-width"];
        paint["text-halo-width"] = typeof w === "number" && w >= 1 ? w : 1.2;
        symbols++;
        break;
      }
      default:
        break;
    }
  }
  log(`dark repaint: ${bg} background, ${fills} fill, ${extrusions} fill-extrusion, ${lines} line, ${symbols} symbol layer(s)`);
  return dark;
}

// ---------------------------------------------------------------------------
async function loadBaseStyle() {
  if (STYLE_FILE) {
    log(`reading base style from file: ${STYLE_FILE}`);
    return JSON.parse(readFileSync(STYLE_FILE, "utf8"));
  }
  log(`fetching Liberty style: ${STYLE_URL}`);
  return (await fetchOrThrow(STYLE_URL)).json();
}

async function main() {
  // 1. Load the resolved base style (network or local file). Do NOT wipe
  //    assets/ — the dark build reuses the light build's fonts + sprite.
  const style = await loadBaseStyle();
  if (!style.sources || !style.layers) die("base style missing sources/layers");

  // 2. Rewrite sources: vector -> local pmtiles; drop remote raster sources.
  const droppedSources = new Set();
  const newSources = {};
  for (const [id, src] of Object.entries(style.sources)) {
    if (src.type === "vector") {
      newSources[id] = { ...src, type: "vector", url: LOCAL_SOURCE_URL };
      delete newSources[id].tiles;
    } else if (src.type === "geojson") {
      // Preserve inline GeoJSON; the display policy removes retired custom outlines.
      newSources[id] = src;
    } else {
      droppedSources.add(id);
      log(`dropping non-vector source "${id}" (type=${src.type}) — not vendored`);
    }
  }
  if (!Object.values(newSources).some((s) => s.type === "vector")) {
    die("no vector source survived the rewrite");
  }
  style.sources = newSources;

  // Remove layers bound to dropped sources.
  const before = style.layers.length;
  style.layers = style.layers.filter((l) => !droppedSources.has(l.source));
  log(`layers: kept ${style.layers.length}/${before} (removed ${before - style.layers.length} using dropped sources)`);

  // Point glyphs + sprite at local tileserver-gl paths (reuse the light sprite).
  style.glyphs = LOCAL_GLYPHS;
  style.sprite = LOCAL_SPRITE;

  // 3. Apply the shared Linefleet display policy, including old style cleanup.
  log("applying the Linefleet map display policy (no custom national outline)");
  const displayed = applyLinefleetMapDisplay(process.env.OVERTURE_PLACES === "1" ? withPlaceOverlay(style) : style);

  // 4. Dark repaint.
  log("applying the dark control-room repaint");
  const dark = darkenColors(displayed);
  dark.name = "liberty-dark";

  // 5. Write styles/liberty-dark.json.
  const outPath = join(ASSETS, "styles", "liberty-dark.json");
  const styleJson = JSON.stringify(dark, null, 2);
  await writeFileEnsured(outPath, styleJson);

  // 6. OFFLINE GUARANTEE — no URL-like remnant may remain (same check as light).
  const forbidden = [
    /https?:\/\//i,
    /"\/\/[^"]/,
    /__TILEJSON_DOMAIN__/,
  ];
  for (const re of forbidden) {
    const m = styleJson.match(re);
    if (m) {
      die(`offline check FAILED — leftover URL-like remnant "${m[0]}" in the dark style.\n` +
          `Fix the rewrite before shipping: any remote URL breaks the offline guarantee.`);
    }
  }
  log("offline check PASSED — no URL-like remnants in the dark style");

  console.log("\nVendored dark style OK:");
  console.log(`  style : ${outPath}`);
  console.log(`  name  : ${dark.name}`);
  console.log(`  layers: ${dark.layers.length} (ma-outline: ${dark.layers.some((l) => l.id === "ma-outline")}, boundary_2: ${dark.layers.some((l) => l.id === "boundary_2")})`);
  console.log("\nServed by tileserver-gl at /styles/liberty-dark/style.json once config.json registers the `liberty-dark` style.");
}

main().catch((err) => die(err.stack || String(err)));
