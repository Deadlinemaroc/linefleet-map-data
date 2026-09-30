#!/usr/bin/env node
/**
 * Apply Linefleet's display policy to an existing style JSON without rebuilding
 * tiles or downloading fonts/sprites. Input and output may be the same path.
 *
 *   node docker/tiles/patch-map-style.mjs INPUT.json OUTPUT.json
 */
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { applyLinefleetMapDisplay } from "./map-display-policy.mjs";

const [inputArg, outputArg, ...extra] = process.argv.slice(2);
if (!inputArg || !outputArg || extra.length) {
  console.error("Usage: node patch-map-style.mjs INPUT.json OUTPUT.json");
  process.exit(1);
}

const input = resolve(inputArg);
const output = resolve(outputArg);
const temporary = `${output}.${process.pid}.tmp`;
try {
  const style = JSON.parse(await readFile(input, "utf8"));
  if (style?.version !== 8 || !style.sources || Array.isArray(style.sources) || typeof style.sources !== "object" || !Array.isArray(style.layers)) {
    throw new Error("Input must be a MapLibre v8 style with sources and layers");
  }
  const patched = applyLinefleetMapDisplay(style);
  const inputMode = (await stat(input)).mode;
  await writeFile(temporary, `${JSON.stringify(patched, null, 2)}\n`, { mode: inputMode, flag: "wx" });
  await rename(temporary, output);
  console.log(`Patched ${output}: ${style.layers.length} → ${patched.layers.length} layers; no custom national outline`);
} catch (error) {
  await rm(temporary, { force: true });
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
