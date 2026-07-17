#!/usr/bin/env node
//
// vendor-liberty-style.mjs — vendor the OpenFreeMap "Liberty" style for OFFLINE
// serving by the tileserver-gl sidecar (F6 / §0). MIT-licensed style
// (github.com/hyperknot/openfreemap-styles).
//
// Run ONCE on a dev/build machine (Node 18+; project ships Node 24), from the
// docker/tiles/ directory:
//
//   node ./vendor-liberty-style.mjs
//
// What it does:
//   1. Fetches the RESOLVED Liberty style JSON from the live OpenFreeMap host
//      (concrete https URLs — not the repo's __TILEJSON_DOMAIN__ placeholders).
//   2. Downloads every referenced glyph (font) PBF + the sprite (png/json, @1x/@2x).
//   3. REWRITES every URL in the style to the tileserver-gl LOCAL paths:
//        - vector source "openmaptiles" -> "pmtiles://{morocco}"   (config.json data id)
//        - glyphs   -> "{fontstack}/{range}.pbf" (paths-relative)
//        - sprite   -> "liberty" (paths-relative)
//      and DROPS the remote raster source "ne2_shaded" (Natural Earth hillshade,
//      not part of our pmtiles) plus any layers that use it.
//   4. Applies `applyOfficialMoroccanView(style)` — the vendored-style TWIN of
//      the web runtime patch (apps/web/src/lib/map-style.ts). Binding client
//      requirement: the official Moroccan map (no disputed separation line/berm,
//      no Western Sahara label) in the EXPORTED VIDEOS too. The pmtiles DATA
//      contains the disputed features; the STYLE filters them — see the block
//      comment on the function for the twin-evolution rule.
//   5. FAILS LOUDLY if any URL-LIKE remnant survives (http(s)://, a
//      protocol-relative "//host" string value, or the __TILEJSON_DOMAIN__
//      placeholder) — that is the offline guarantee: one leftover remote URL
//      silently breaks it. Benign occurrences of words like "openfreemap" in a
//      name/metadata string do NOT trip it.
//
// Outputs (all git-ignored — regenerate at deploy time; see .gitignore):
//   assets/styles/liberty.json
//   assets/fonts/<fontstack>/<start>-<end>.pbf
//   assets/sprites/liberty.{json,png} + liberty@2x.{json,png}
//
// NOTE: this makes ONE-TIME network calls to OpenFreeMap. It was NOT run in the
// authoring sandbox (egress blocked). Run it on a networked build machine.

import { mkdir, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(HERE, "assets");

// Morocco's outline WITH Western Sahara merged in (union of the MAR + ESH country
// polygons, internal disputed border dissolved — see morocco-unified.geojson +
// public/vendor/README provenance). Embedded INLINE into the style so both the
// browser (MapLibre GL JS) and the server-side video renderer (maplibre-gl-native)
// resolve it with no extra fetch. This is the country border we draw AFTER the
// OSM admin_level-2 boundary layer (the "Western Sahara box") is removed.
const MOROCCO_OUTLINE = JSON.parse(
  readFileSync(join(HERE, "morocco-unified.geojson"), "utf8"),
);

const OFM_BASE = (process.env.OFM_BASE ?? "https://tiles.openfreemap.org").replace(/\/+$/, "");
const STYLE_URL = process.env.STYLE_URL ?? `${OFM_BASE}/styles/liberty`;
// Glyph ranges: MapLibre uses 256-codepoint windows (0-255 .. 65280-65535).
// We probe them all so Latin + Arabic (Morocco is fr/ar) are fully covered;
// non-existent ranges 404 and are skipped.
const GLYPH_RANGE_STEP = 256;
const GLYPH_RANGE_MAX = 65535;
const FETCH_CONCURRENCY = 8;

// Local rewrite targets (must match config.json paths + the sprite/font layout).
const LOCAL_SOURCE_URL = "pmtiles://{morocco}"; // config.json data id "morocco"
// tileserver-gl resolves the style's sprite/glyphs values AGAINST options.paths
// (paths.sprites=/data/sprites, paths.fonts=/data/fonts) — so the style values
// must NOT repeat the directory segment. "sprites/liberty" resolved to
// /data/sprites/sprites/liberty (ENOENT -> every static render 500'd, hit live
// on the first staging deploy 2026-07-17). Values below are paths-RELATIVE.
const LOCAL_GLYPHS = "{fontstack}/{range}.pbf";
const LOCAL_SPRITE = "liberty";

// ---------------------------------------------------------------------------
function log(...a) { console.log("==>", ...a); }
function die(msg) { console.error("\nERROR:", msg); process.exit(1); }

async function fetchOrThrow(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res;
}

// Returns a Buffer, or null when the resource legitimately does not exist (404).
async function fetchBufferOptional(url) {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Tiny bounded-concurrency runner.
async function mapLimit(items, limit, fn) {
  const results = [];
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function writeFileEnsured(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

// ---------------------------------------------------------------------------
// « Carte officielle du Maroc » — vendored-style twin of the web runtime patch.
//
// ⚠️ TWIN FILE: apps/web/src/lib/map-style.ts (`applyOfficialMoroccanView`) is
// the REFERENCE implementation — its header documents the empirically-observed
// layer/property reality (style JSON + decoded planet tiles z1–z6 around
// 27.66°N). The web patches the live style at RUNTIME; this patches the
// VENDORED style the tileserver-gl video sidecar renders. The client
// requirement covers BOTH surfaces, so the two implementations MUST evolve
// together: any change there (new selectors, name variants, layer families)
// must be mirrored here, and vice-versa.
//
// Same transformations as the web twin:
//   (a) remove every layer that renders disputed boundaries on source-layer
//       "boundary" (id contains "disputed" or filter selects disputed==1 —
//       Liberty's dashed `boundary_disputed` layer);
//   (b) tighten every remaining `boundary` layer with disputed != 1 AND
//       !has claimed_by (Liberty's boundary_2/boundary_3 already carry these —
//       the AND is deduplicated, so it is a no-op there and insurance against
//       a future style reshuffle leaking the line back);
//   (c) exclude any Western Sahara label from every `place` layer — by
//       iso_a2=="EH" AND by name variants (case/diacritic-tolerant, incl. the
//       no-space Arabic form) across every name/name:* property the style's
//       text-fields read. Current builds carry NO WS label (the territory is
//       labeled with the official Moroccan regions) — this filter is DEFENSIVE
//       against a future tile/style build reintroducing it.
// Both expression and legacy filter syntaxes are handled, matching the twin
// (Liberty is expression; legacy keeps the patch correct if STYLE_URL is ever
// pointed at an older legacy-filter style).

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
  // No offshore boundary diagonals — parity with the web twin
  // (apps/web/src/lib/map-style.ts). No-op here: base Liberty already excludes
  // maritime in boundary_2/boundary_3, so andClauses dedupes it. Kept so the
  // twins stay identical (the client requirement covers video + web alike).
  ["!=", ["get", "maritime"], 1],
];
const BOUNDARY_EXCLUSIONS_LEGACY = [
  ["!=", "disputed", 1],
  ["!has", "claimed_by"],
  ["!=", "maritime", 1], // parity with the web twin (see expr note above)
];

/** Lower-case needles; haystacks are downcased. Spanish keeps its accent —
 *  `downcase` does not fold diacritics, so both forms are listed. */
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
      // substring test, case-tolerant, safe when the property is absent
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

/**
 * Returns a patched COPY of a MapLibre style enforcing the official Moroccan
 * view — same contract as the web twin (never mutates its input; worst case
 * on a malformed style it returns an equivalent copy).
 */
/** admin_level==2 selector, in both syntaxes — identifies the country-border layer. */
function selectsAdminLevel2(filter) {
  if (!Array.isArray(filter)) return false;
  const s = JSON.stringify(filter);
  return s.includes('["get","admin_level"],2]') || s.includes('"admin_level",2]');
}

function applyOfficialMoroccanView(style) {
  const patched = structuredClone(style);
  if (!Array.isArray(patched.layers)) return patched;

  // Drop BOTH the disputed boundary layer(s) AND the admin_level-2 country-border
  // layer (`boundary_2`). WHY level-2 too: the "Western Sahara box" (the stepped
  // southern outline + the ~27.66°N separation) is an admin_level-2 line tagged
  // IDENTICALLY to Morocco's real external borders (disputed=0, adm0=MAR/none), so
  // it cannot be filtered out by attribute without also dropping legitimate
  // borders. We therefore remove level-2 rendering entirely and REDRAW Morocco's
  // border from the unified MAR+ESH outline (added below) — no internal WS line.
  // The admin_level 3-6 layer (`boundary_3` = the 12 official regions) is KEPT.
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

  // Redraw Morocco's country border from the unified outline (Sahara merged in,
  // no internal WS line). Inline geojson source; styled to match the removed
  // boundary_2 line so it reads as the national border. Inserted just below the
  // first label layer so labels stay on top.
  patched.sources = patched.sources ?? {};
  patched.sources["ma-unified"] = { type: "geojson", data: MOROCCO_OUTLINE };
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
    // Liberty ships `boundary_disputed`; its absence means the upstream style
    // changed shape — the tightened filters still hold the line out, but the
    // twin (map-style.ts) must be re-verified against the new style.
    console.warn(
      "WARN: no dedicated disputed layer found — upstream style changed? Re-verify the web twin (apps/web/src/lib/map-style.ts).",
    );
  }
  return patched;
}

// ---------------------------------------------------------------------------
async function main() {
  await rm(ASSETS, { recursive: true, force: true });
  await mkdir(ASSETS, { recursive: true });

  // 1. Fetch the resolved style.
  log(`fetching Liberty style: ${STYLE_URL}`);
  const style = await (await fetchOrThrow(STYLE_URL)).json();
  if (!style.sources || !style.layers) die("fetched style missing sources/layers");

  // Capture the ORIGINAL glyph + sprite templates BEFORE rewriting.
  const origGlyphs = style.glyphs; // e.g. https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf
  const origSprite = style.sprite; // e.g. https://tiles.openfreemap.org/sprites/ofm_f384/ofm
  if (typeof origGlyphs !== "string" || !origGlyphs.includes("{fontstack}")) {
    die(`unexpected glyphs template: ${JSON.stringify(origGlyphs)}`);
  }
  if (typeof origSprite !== "string") die(`unexpected sprite value: ${JSON.stringify(origSprite)}`);

  // 2. Rewrite sources: keep vector -> pmtiles; drop remote raster sources.
  const droppedSources = new Set();
  const newSources = {};
  for (const [id, src] of Object.entries(style.sources)) {
    if (src.type === "vector") {
      // Preserve the source KEY (layers reference it by name) and vector attrs
      // that don't point outward; only swap the pointer to our local pmtiles.
      newSources[id] = { ...src, type: "vector", url: LOCAL_SOURCE_URL };
      delete newSources[id].tiles;
    } else {
      // Raster/other sources (e.g. ne2_shaded Natural Earth hillshade) are not
      // in our pmtiles and would leave a remote URL -> drop them.
      droppedSources.add(id);
      log(`dropping non-vector source "${id}" (type=${src.type}) — not vendored`);
    }
  }
  if (!Object.keys(newSources).length) die("no vector source survived the rewrite");
  style.sources = newSources;

  // Remove layers bound to dropped sources.
  const before = style.layers.length;
  style.layers = style.layers.filter((l) => !droppedSources.has(l.source));
  log(`layers: kept ${style.layers.length}/${before} (removed ${before - style.layers.length} using dropped sources)`);

  // Point glyphs + sprite at local tileserver-gl paths.
  style.glyphs = LOCAL_GLYPHS;
  style.sprite = LOCAL_SPRITE;

  // 3. « Carte officielle du Maroc » — official-view patch (twin of the web
  // runtime patch, see the block comment above applyOfficialMoroccanView).
  log("applying the official Moroccan view (twin of apps/web/src/lib/map-style.ts)");
  const official = applyOfficialMoroccanView(style);

  // 4. Collect the font stacks actually referenced by the surviving layers.
  const fontstacks = new Set();
  for (const layer of official.layers) {
    const tf = layer.layout && layer.layout["text-font"];
    if (Array.isArray(tf)) for (const f of tf) if (typeof f === "string") fontstacks.add(f);
  }
  if (!fontstacks.size) die("no font stacks referenced by layers");
  log(`font stacks (${fontstacks.size}): ${[...fontstacks].join(", ")}`);

  // 5. Download glyph PBFs for each stack across all ranges (404 = skip).
  const ranges = [];
  for (let start = 0; start <= GLYPH_RANGE_MAX; start += GLYPH_RANGE_STEP) {
    ranges.push(`${start}-${Math.min(start + GLYPH_RANGE_STEP - 1, GLYPH_RANGE_MAX)}`);
  }
  let glyphCount = 0;
  for (const stack of fontstacks) {
    const saved = await mapLimit(ranges, FETCH_CONCURRENCY, async (range) => {
      const url = origGlyphs
        .replace("{fontstack}", encodeURIComponent(stack))
        .replace("{range}", range);
      const buf = await fetchBufferOptional(url);
      if (!buf) return 0;
      // Serve dir uses the LITERAL stack name (spaces intact): fonts/<stack>/<range>.pbf
      await writeFileEnsured(join(ASSETS, "fonts", stack, `${range}.pbf`), buf);
      return 1;
    });
    const n = saved.reduce((a, b) => a + b, 0);
    glyphCount += n;
    log(`  glyphs "${stack}": ${n} ranges`);
  }
  if (!glyphCount) die("downloaded 0 glyph ranges — check OFM_BASE / connectivity");

  // 6. Download sprite (1x + 2x, json + png) -> assets/sprites/liberty.*
  const spriteVariants = [
    { suffix: "", ext: "json", out: "liberty.json" },
    { suffix: "", ext: "png", out: "liberty.png" },
    { suffix: "@2x", ext: "json", out: "liberty@2x.json" },
    { suffix: "@2x", ext: "png", out: "liberty@2x.png" },
  ];
  let spriteCount = 0;
  for (const v of spriteVariants) {
    const url = `${origSprite}${v.suffix}.${v.ext}`;
    const buf = await fetchBufferOptional(url);
    if (!buf) { log(`  sprite ${v.out}: absent (skipped)`); continue; }
    await writeFileEnsured(join(ASSETS, "sprites", v.out), buf);
    spriteCount++;
  }
  if (spriteCount < 2) die(`sprite download incomplete (${spriteCount} files) — expected at least liberty.json + liberty.png`);
  log(`sprite files: ${spriteCount}`);

  // 7. Write the rewritten, official-view-patched style.
  const styleJson = JSON.stringify(official, null, 2);
  await writeFileEnsured(join(ASSETS, "styles", "liberty.json"), styleJson);

  // 8. OFFLINE GUARANTEE: no URL-LIKE remnant may remain anywhere in the style.
  // URL-LIKE ONLY — http(s)://, a protocol-relative "//host" string value, or
  // the repo's __TILEJSON_DOMAIN__ placeholder (which resolves to a remote URL
  // at serve time). Deliberately NOT bare words like "openfreemap": a style's
  // name/metadata legitimately contains them and must not fail vendoring.
  const forbidden = [
    /https?:\/\//i, // absolute http(s) URL anywhere
    /"\/\/[^"]/, // JSON string value starting with a protocol-relative //host
    /__TILEJSON_DOMAIN__/, // unresolved placeholder -> becomes a remote URL
  ];
  for (const re of forbidden) {
    const m = styleJson.match(re);
    if (m) die(`offline check FAILED — leftover URL-like remnant "${m[0]}" in the vendored style.\n` +
               `Fix the rewrite before shipping: any remote URL breaks the offline guarantee.`);
  }
  log("offline check PASSED — no URL-like remnants (http(s)://, protocol-relative, placeholder) in the style");

  console.log("\nVendored OK:");
  console.log(`  style : ${join(ASSETS, "styles", "liberty.json")}`);
  console.log(`  glyphs: ${glyphCount} PBFs across ${fontstacks.size} stacks -> ${join(ASSETS, "fonts")}`);
  console.log(`  sprite: ${spriteCount} files -> ${join(ASSETS, "sprites")}`);
  console.log("\nThese assets + config.json are what the tileserver-gl volume must contain.");
}

main().catch((err) => die(err.stack || String(err)));
