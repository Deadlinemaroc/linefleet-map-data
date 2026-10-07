#!/usr/bin/env node
/**
 * build-world-labels.mjs — curate the inline country-label list for the world
 * base from Natural Earth 110m admin_0 countries (public domain).
 *
 *   node build-world-labels.mjs [path/to/ne_110m_admin_0_countries.geojson]
 *
 * Writes world-country-labels.geojson next to this script. Exclusions are the
 * display policy's: no label for the excluded territory under any of its names
 * or codes. The national entry is kept with `national: true` so the style can
 * show it only below zoom 2 (the national tiles label the country from zoom 2).
 * Everything else: French-first names with an Arabic second line, like every
 * other label in the app, and a rank tier (1–3) from Natural Earth's LABELRANK.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const NE_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson";

export const EXCLUDED_CODES = new Set(["SAH", "EH"]);
export const EXCLUDED_NEEDLES = ["western sahara", "w. sahara", "sahara occidental", "sáhara occidental", "الصحراء الغربية", "الصحراءالغربية"];

export function isExcluded(properties) {
  if (EXCLUDED_CODES.has(properties.ADM0_A3) || EXCLUDED_CODES.has(properties.ISO_A2) || EXCLUDED_CODES.has(properties.ISO_A2_EH)) return true;
  const names = [properties.NAME, properties.NAME_EN, properties.NAME_FR, properties.NAME_AR, properties.SOVEREIGNT].filter(Boolean).map((n) => String(n).toLowerCase());
  return names.some((name) => EXCLUDED_NEEDLES.some((needle) => name.includes(needle)));
}

export function tier(labelrank) {
  if (labelrank <= 2) return 1;
  if (labelrank <= 4) return 2;
  return 3;
}

export function curate(ne) {
  const features = [];
  for (const feature of ne.features) {
    const p = feature.properties;
    if (isExcluded(p)) continue;
    if (!Number.isFinite(p.LABEL_X) || !Number.isFinite(p.LABEL_Y)) continue;
    if (p.TYPE === "Dependency" || p.TYPE === "Lease") continue;
    const national = p.ADM0_A3 === "MAR";
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [Number(p.LABEL_X.toFixed(4)), Number(p.LABEL_Y.toFixed(4))] },
      properties: {
        name: p.NAME_EN ?? p.NAME,
        name_en: p.NAME_EN ?? p.NAME,
        "name:latin": p.NAME_EN ?? p.NAME,
        "name:fr": p.NAME_FR ?? p.NAME_EN ?? p.NAME,
        "name:ar": p.NAME_AR ?? "",
        "name:nonlatin": p.NAME_AR ?? "",
        iso_a2: p.ISO_A2,
        adm0_a3: p.ADM0_A3,
        rank: national ? 1 : tier(Number(p.LABELRANK ?? 5)),
        ...(national ? { national: true } : {}),
      },
    });
  }
  features.sort((a, b) => a.properties.adm0_a3.localeCompare(b.properties.adm0_a3));
  return { type: "FeatureCollection", features };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = process.argv[2];
  const raw = input ? await readFile(input, "utf8") : await (await fetch(NE_URL)).text();
  const curated = curate(JSON.parse(raw));
  const out = join(HERE, "world-country-labels.geojson");
  await writeFile(out, `${JSON.stringify(curated)}\n`);
  console.log(`wrote ${out}: ${curated.features.length} labels`);
}
