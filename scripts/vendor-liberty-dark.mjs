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
//   3. Applies `applyOfficialMoroccanView(style)` — the SAME Western-Sahara
//      scrub as the light build (TWIN, copied verbatim below): removes disputed
//      layers + admin_level-2 (`boundary_2`), redraws the unified national
//      land border as `ma-outline`, keeps `boundary_3` regions, excludes WS
//      labels.
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

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(HERE, "assets");

// ⚠️ TWIN of apps/web/src/lib/morocco-land-border.ts (browser runtime copy) and
// of docker/tiles/vendor-liberty-style.mjs (the light build). Same inline
// geojson — the unified LAND frontier (Western Sahara merged in, internal
// disputed line dissolved, NO coast). See the light build for the full rationale.
const MOROCCO_LAND_BORDER = JSON.parse(
  readFileSync(join(HERE, "morocco-land-border.geojson"), "utf8"),
);

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
// « Carte officielle du Maroc » — Western-Sahara scrub.
//
// ⚠️ TWIN (verbatim copy) of `applyOfficialMoroccanView` in
// docker/tiles/vendor-liberty-style.mjs (the light build), which is itself the
// vendored twin of apps/web/src/lib/map-style.ts. The THREE implementations
// (web runtime / light vendor / dark vendor) MUST evolve together: any change
// to selectors, name variants, or layer families in one must be mirrored in the
// others. It is copied here rather than imported because the light module runs
// its `main()` on import (network calls + writes). See the light build's block
// comment for the full contract; the code below is byte-for-byte identical.
// ===========================================================================

/** disputed==1 selector, in both syntaxes — identifies dedicated disputed layers. */
const DISPUTED_SELECTORS = new Set([
  JSON.stringify(["==", ["get", "disputed"], 1]),
  JSON.stringify(["==", "disputed", 1]),
]);

function containsDisputedSelector(filter) {
  if (!Array.isArray(filter)) return false;
  if (DISPUTED_SELECTORS.has(JSON.stringify(filter))) return true;
  return filter.some(containsDisputedSelector);
}

/** Expression filters reference properties via ["get", key] — legacy never does. */
function isExpressionFilter(filter) {
  if (!Array.isArray(filter)) return true; // absent filter → emit modern syntax
  if (filter[0] === "get") return true;
  return filter.some((part) => Array.isArray(part) && isExpressionFilter(part));
}

/** AND extra clauses into an existing filter, deduplicated, preserving shape. */
function andClauses(filter, clauses) {
  const existing =
    Array.isArray(filter) && filter[0] === "all"
      ? filter.slice(1)
      : filter === undefined
        ? []
        : [filter];
  const seen = new Set(existing.map((c) => JSON.stringify(c)));
  const merged = [...existing];
  for (const clause of clauses) {
    const key = JSON.stringify(clause);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(clause);
  }
  return ["all", ...merged];
}

const BOUNDARY_EXCLUSIONS_EXPR = [
  ["!=", ["get", "disputed"], 1],
  ["!", ["has", "claimed_by"]],
  ["!=", ["get", "maritime"], 1],
];
const BOUNDARY_EXCLUSIONS_LEGACY = [
  ["!=", "disputed", 1],
  ["!has", "claimed_by"],
  ["!=", "maritime", 1],
];

/** Lower-case needles; haystacks are downcased. */
const WS_NEEDLES = [
  "western sahara",
  "sahara occidental",
  "sáhara occidental",
  "الصحراء الغربية",
  "الصحراءالغربية",
];

/** Every name property the style's text-fields read, plus common fallbacks. */
const WS_NAME_PROPS = [
  "name",
  "name_en",
  "name_int",
  "name:latin",
  "name:nonlatin",
  "name:fr",
  "name:es",
  "name:ar",
];

function placeExclusionsExpr() {
  const clauses = [["!=", ["get", "iso_a2"], "EH"]];
  for (const prop of WS_NAME_PROPS) {
    for (const needle of WS_NEEDLES) {
      clauses.push(["!", ["in", needle, ["downcase", ["coalesce", ["get", prop], ""]]]]);
    }
  }
  return clauses;
}

/** Legacy filters cannot do substrings — exact-match exclusion on the variants. */
function placeExclusionsLegacy() {
  const variants = ["Western Sahara", "Sahara Occidental", "Sáhara Occidental", "الصحراء الغربية"];
  const clauses = [["!=", "iso_a2", "EH"]];
  for (const prop of WS_NAME_PROPS) clauses.push(["!in", prop, ...variants]);
  return clauses;
}

/** admin_level==2 selector, in both syntaxes — identifies the country-border layer. */
function selectsAdminLevel2(filter) {
  if (!Array.isArray(filter)) return false;
  const s = JSON.stringify(filter);
  return s.includes('["get","admin_level"],2]') || s.includes('"admin_level",2]');
}

function applyOfficialMoroccanView(style) {
  const patched = structuredClone(style);
  if (!Array.isArray(patched.layers)) return patched;

  const removed = [];
  let level2Layout = null;
  let level2Paint = null;
  patched.layers = patched.layers.filter((layer) => {
    if (typeof layer !== "object" || layer === null) return true;
    if (!("source-layer" in layer) || layer["source-layer"] !== "boundary") return true;
    const isLevel2 = layer.id === "boundary_2" || selectsAdminLevel2(layer.filter);
    if (isLevel2) {
      level2Layout = layer.layout ?? null;
      level2Paint = layer.paint ?? null;
      removed.push(layer.id);
      return false;
    }
    const drop = /disputed/i.test(layer.id) || containsDisputedSelector(layer.filter);
    if (drop) removed.push(layer.id);
    return !drop;
  });

  let boundaryCount = 0;
  let placeCount = 0;
  for (const layer of patched.layers) {
    if (typeof layer !== "object" || layer === null || !("source-layer" in layer)) continue;
    if (layer["source-layer"] === "boundary") {
      const expr = isExpressionFilter(layer.filter);
      layer.filter = andClauses(
        layer.filter,
        expr ? BOUNDARY_EXCLUSIONS_EXPR : BOUNDARY_EXCLUSIONS_LEGACY,
      );
      boundaryCount++;
    } else if (layer["source-layer"] === "place") {
      const expr = isExpressionFilter(layer.filter);
      layer.filter = andClauses(
        layer.filter,
        expr ? placeExclusionsExpr() : placeExclusionsLegacy(),
      );
      placeCount++;
    }
  }

  // Redraw Morocco's country border from the unified LAND frontier.
  patched.sources = patched.sources ?? {};
  patched.sources["ma-unified"] = { type: "geojson", data: MOROCCO_LAND_BORDER };
  const outlineLayer = {
    id: "ma-outline",
    type: "line",
    source: "ma-unified",
    layout: level2Layout ?? { "line-cap": "round", "line-join": "round" },
    paint: level2Paint ?? {
      "line-color": "hsl(248,1%,41%)",
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 0, 0.4, 4, 1],
      "line-width": ["interpolate", ["linear"], ["zoom"], 3, 1, 5, 1.2, 12, 3],
    },
  };
  const firstLabelIdx = patched.layers.findIndex(
    (l) => typeof l === "object" && l !== null && l.type === "symbol",
  );
  if (firstLabelIdx >= 0) patched.layers.splice(firstLabelIdx, 0, outlineLayer);
  else patched.layers.push(outlineLayer);

  log(`official view: removed layer(s): ${removed.length ? removed.join(", ") : "(none found)"}; added ma-outline (unified border)`);
  log(`official view: tightened ${boundaryCount} boundary layer(s), ${placeCount} place label layer(s)`);
  if (!removed.length) {
    console.warn(
      "WARN: no dedicated disputed layer found — upstream style changed? Re-verify the twins (map-style.ts + vendor-liberty-style.mjs).",
    );
  }
  return patched;
}

// ===========================================================================
// darkenColors — repaint the base cartography to a cohesive control-room dark.
//
// Professional dark theme (NOT pure black): a very dark desaturated blue-grey
// base, water a touch bluer, buildings a touch lighter, mid-grey roads with a
// warm motorway hint, light text on a dark halo. Data-driven color expressions
// are replaced with the flat dark color (acceptable for this theme); opacity /
// width expressions are left intact. Runs AFTER applyOfficialMoroccanView so
// the `ma-outline` national border gets its dark-appropriate color too.
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
  border: "hsl(0, 0%, 55%)",        // ma-outline national border — visible on dark
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

/** Pick a line color by role — border > water > boundary > casing > motorway > road. */
function lineColorFor(layer) {
  const sl = layer["source-layer"];
  const id = String(layer.id ?? "");
  if (id === "ma-outline") return DARK.border;
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
      // Inline geojson (e.g. a pre-existing ma-unified) has no outward URL — keep.
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

  // 3. Official Moroccan view — SAME scrub as the light build (twin).
  log("applying the official Moroccan view (twin of vendor-liberty-style.mjs)");
  const official = applyOfficialMoroccanView(style);

  // 4. Dark repaint.
  log("applying the dark control-room repaint");
  const dark = darkenColors(official);
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
