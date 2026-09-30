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
//   4. Applies the Linefleet map display policy from map-display-policy.mjs.
//      Suppresses country/disputed boundary layers, old custom outlines and
//      selected place labels. Roads, cities and regional layers remain.
//      This display choice does not assert authoritative boundary geometry.
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyLinefleetMapDisplay } from "./map-display-policy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(HERE, "..", "assets");

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

  // 3. Apply the same display choice as the web/mobile runtime guard.
  log("applying the Linefleet map display policy (no custom national outline)");
  const displayed = applyLinefleetMapDisplay(style);

  // 4. Collect the font stacks actually referenced by the surviving layers.
  const fontstacks = new Set();
  for (const layer of displayed.layers) {
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

  // 7. Write the rewritten, display-policy-patched style.
  const styleJson = JSON.stringify(displayed, null, 2);
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
