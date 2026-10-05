/**
 * Linefleet's map display policy for OpenMapTiles/Liberty styles.
 *
 * This is a presentation preference, not an authoritative boundary dataset or
 * a legal statement. Do not substitute a traced/generalized national outline:
 * earlier ma-unified geometry produced visibly inaccurate lines. Until an
 * approved accurate source is available, suppress the country/disputed lines
 * and selected place labels while retaining roads, cities and regional layers.
 *
 * Keep this behavior in sync with the web/mobile runtime guard.
 * This module has no network or filesystem side effects.
 */

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
  [">", ["get", "admin_level"], 2],
  ["!=", ["get", "disputed"], 1],
  ["!", ["has", "claimed_by"]],
  // Preserve the existing exclusion of offshore boundary diagonals.
  ["!=", ["get", "maritime"], 1],
];
const BOUNDARY_EXCLUSIONS_LEGACY = [
  [">", "admin_level", 2],
  ["!=", "disputed", 1],
  ["!has", "claimed_by"],
  ["!=", "maritime", 1],
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

/** admin_level==2 selector in both expression and legacy filter syntax. */
function selectsAdminLevel2(filter) {
  if (!Array.isArray(filter)) return false;
  if (filter[0] === "==" && filter[2] === 2) {
    const property = filter[1];
    if (property === "admin_level") return true;
    if (Array.isArray(property) && property[0] === "get" && property[1] === "admin_level") return true;
  }
  return filter.some(selectsAdminLevel2);
}

/** Return a patched copy; repeated application produces the same style. */
// Ignore empty multilingual fields: coalesce alone treats an empty name as valid.
function firstName(properties) {
  const cases = ["case"];
  for (const property of properties) cases.push(["!=", ["coalesce", ["get", property], ""], ""], ["get", property]);
  cases.push("");
  return cases;
}

/** French-first, with a distinct Arabic line and native-name fallback. */
const PLACE_LABEL = [
  "let", "primary", firstName(["name:fr", "name:latin", "name", "name_en"]),
  "secondary", firstName(["name:ar", "name:nonlatin"]),
  ["case", ["all", ["!=", ["var", "secondary"], ""], ["!=", ["var", "primary"], ""], ["!=", ["var", "primary"], ["var", "secondary"]]],
    ["concat", ["var", "primary"], "\n", ["var", "secondary"]],
    ["case", ["!=", ["var", "primary"], ""], ["var", "primary"], ["var", "secondary"]]],
];
const POI_ZOOMS = { poi_r1: 14, poi_r7: 15, poi_r20: 16 };

export function applyLinefleetMapDisplay(style) {
  const patched = structuredClone(style);
  if (typeof patched !== "object" || patched === null || Array.isArray(patched)) return patched;

  // Also handles older pre-patched styles, including renamed outline layers.
  if (patched.sources && typeof patched.sources === "object") delete patched.sources["ma-unified"];
  if (!Array.isArray(patched.layers)) return patched;
  patched.layers = patched.layers.filter((layer) => {
    if (typeof layer !== "object" || layer === null) return true;
    if (layer.id === "ma-outline" || layer.source === "ma-unified") return false;
    if (layer["source-layer"] !== "boundary") return true;
    if (layer.id === "boundary_2" || selectsAdminLevel2(layer.filter)) return false;
    return !/disputed/i.test(layer.id) && !containsDisputedSelector(layer.filter);
  });

  for (const layer of patched.layers) {
    if (typeof layer !== "object" || layer === null) continue;
    if (layer.type === "symbol" && layer.layout && /name/.test(JSON.stringify(layer.layout["text-field"]))) {
      layer.layout["text-field"] = PLACE_LABEL;
      // Keep normal collision handling: more places, not overlapping text.
      const zoom = POI_ZOOMS[layer.id];
      if (zoom !== undefined) layer.minzoom = Math.min(layer.minzoom ?? zoom, zoom);
    }
    // The schema has POI classes without a Liberty sprite (office, ATM, gates).
    // A missing icon must not suppress a useful name. Resolve the known sprite
    // first, otherwise use the small bundled generic dot; preserve collisions.
    const icon = layer.layout?.["icon-image"];
    if (layer.id.startsWith("poi_") && icon && !(Array.isArray(icon) && icon[0] === "coalesce" && Array.isArray(icon[1]) && icon[1][0] === "image")) {
      layer.layout["icon-image"] = ["coalesce", ["image", icon], ["image", "circle_11"]];
      layer.layout["icon-optional"] = true;
    }
    if (layer["source-layer"] === "boundary") {
      layer.filter = andClauses(
        layer.filter,
        isExpressionFilter(layer.filter) ? BOUNDARY_EXCLUSIONS_EXPR : BOUNDARY_EXCLUSIONS_LEGACY,
      );
    } else if (layer["source-layer"] === "place") {
      layer.filter = andClauses(
        layer.filter,
        isExpressionFilter(layer.filter) ? placeExclusionsExpr() : placeExclusionsLegacy(),
      );
    }
  }
  return patched;
}
