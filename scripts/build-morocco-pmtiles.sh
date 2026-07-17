#!/usr/bin/env bash
#
# ⚠️ Synced from LINEFLEET_TRT docker/tiles/ (the dev/local twin) — keep the
# pair in sync; the PRODUCTION rebuild runs HERE (.github/workflows/build.yml).
#
# build-morocco-pmtiles.sh — ONE-TIME, offline Morocco basemap build (F6 / §0).
#
# Produces `morocco.pmtiles` (OpenMapTiles vector schema) that the tileserver-gl
# sidecar serves. Run this on a DEV MACHINE or a build host — NEVER on the VPS:
# it needs Java 21+, a ~243 MB Geofabrik download, several GB of scratch disk and
# a few minutes of CPU. The output is uploaded to MinIO and copied into the
# sidecar volume (see README.md). It is NOT baked into any Docker image.
#
# The OpenMapTiles schema is Planetiler's DEFAULT profile, and it is exactly what
# the app's OpenFreeMap "Liberty" style targets — so exported videos match the
# live map. Licenses: Planetiler Apache-2.0, output data ODbL/CC-BY (attribution
# « © OpenMapTiles © OpenStreetMap contributors » is burned into every video).
#
# ---------------------------------------------------------------------------
# WESTERN SAHARA (verified 2026-07, see README "Coverage"):
#   Geofabrik ships NO separate `western-sahara` extract — that URL 404s. The
#   Morocco extract's own boundary polygon already reaches ~20.88°N (Lagouira /
#   the 21°N parallel), i.e. it INCLUDES Western Sahara down to Dakhla/Laayoune.
#   So the §0 default "include Western Sahara" needs NO merge: the plain Morocco
#   extract covers it. `WITH_WESTERN_SAHARA=1` (default) therefore builds the
#   extract as-is; `WITH_WESTERN_SAHARA=0` clips the OUTPUT to a Morocco-proper
#   bbox via Planetiler `--bounds`.
#
#   `EXTRA_PBF_URLS` is an ADVANCED knob for supplementary extracts from other
#   sources (BBBike, a manual Overpass export, ...). When set, they are
#   osmium-merged with Morocco into `morocco-full.osm.pbf` before Planetiler.
#   It is EMPTY by default because Geofabrik's Morocco extract needs nothing
#   merged in.
# ---------------------------------------------------------------------------
#
# Usage:
#   ./scripts/build-morocco-pmtiles.sh
#   WITH_WESTERN_SAHARA=0 ./scripts/build-morocco-pmtiles.sh   # Morocco proper only
#   EXTRA_PBF_URLS="https://host/extra.osm.pbf" ./scripts/build-morocco-pmtiles.sh
#   PLANETILER_VERSION=v0.10.2 XMX=6g ./scripts/build-morocco-pmtiles.sh
#
set -euo pipefail

# --- Tunables (override via env) -------------------------------------------
PLANETILER_VERSION="${PLANETILER_VERSION:-v0.10.2}"   # pinned; latest stable 2026-03-29
WITH_WESTERN_SAHARA="${WITH_WESTERN_SAHARA:-1}"       # 1 = include (default), 0 = clip out
MOROCCO_PBF_URL="${MOROCCO_PBF_URL:-https://download.geofabrik.de/africa/morocco-latest.osm.pbf}"
EXTRA_PBF_URLS="${EXTRA_PBF_URLS:-}"                  # space-separated; osmium-merged when set
OUTPUT_NAME="${OUTPUT_NAME:-morocco.pmtiles}"
XMX="${XMX:-4g}"                                      # JVM heap; Planetiler suggests ~0.5x the .pbf size
WORK_DIR="${WORK_DIR:-./build}"                       # scratch + outputs (git-ignored)

# Morocco-proper bbox (minLon,minLat,maxLon,maxLat) used only when
# WITH_WESTERN_SAHARA=0. Approximate — the southern limit of "Morocco proper"
# (~27.66°N near Tarfaya/Guelmim) is contested; adjust if you need a precise cut.
MOROCCO_PROPER_BBOX="${MOROCCO_PROPER_BBOX:--13.3,27.6,-0.99,36.06}"

PLANETILER_JAR_URL="https://github.com/onthegomap/planetiler/releases/download/${PLANETILER_VERSION}/planetiler.jar"

# --- Helpers ----------------------------------------------------------------
log() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }

# download <url> <dest> — prefer curl, fall back to wget; skip if dest exists.
download() {
  local url="$1" dest="$2"
  if [ -f "${dest}" ]; then
    log "already present, skipping download: ${dest}"
    return 0
  fi
  log "downloading ${url}"
  if command -v curl >/dev/null 2>&1; then
    curl -fSL --retry 3 -o "${dest}" "${url}"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "${dest}" "${url}"
  else
    die "need curl or wget to download files"
  fi
}

# --- Preflight --------------------------------------------------------------
need java
JAVA_MAJOR="$(java -version 2>&1 | awk -F'"' '/version/ {print $2}' | awk -F. '{print ($1=="1"?$2:$1)}')"
[ -n "${JAVA_MAJOR}" ] && [ "${JAVA_MAJOR}" -ge 21 ] 2>/dev/null \
  || die "Java 21+ required (found: $(java -version 2>&1 | head -1))"

if [ -n "${EXTRA_PBF_URLS}" ]; then
  need osmium   # osmium-tool, only needed for the merge path
fi

mkdir -p "${WORK_DIR}"
WORK_DIR="$(cd "${WORK_DIR}" && pwd)"   # absolutize so Planetiler's ./data lands here

# EARLY GUARD — Planetiler parses --output as a java.net.URI: a space ANYWHERE
# in the resolved path crashes it with `URISyntaxException: Illegal character
# in path` (bit us on a real run — the default ./build under a repo checkout
# whose path contains spaces resolves to a spaced absolute path). Fail now,
# before any download work.
case "${WORK_DIR}" in
  *[[:space:]]*)
    die "WORK_DIR resolves to '${WORK_DIR}', which contains spaces — Planetiler parses --output as a URI and crashes on spaces (URISyntaxException: Illegal character in path). Re-run with a space-free scratch dir, e.g.: WORK_DIR=/tmp/linefleet-tiles ./scripts/build-morocco-pmtiles.sh"
    ;;
esac

cd "${WORK_DIR}"

PLANETILER_JAR="${WORK_DIR}/planetiler-${PLANETILER_VERSION}.jar"
OUTPUT_PATH="${WORK_DIR}/${OUTPUT_NAME}"

# --- 1. Planetiler jar (pinned) --------------------------------------------
download "${PLANETILER_JAR_URL}" "${PLANETILER_JAR}"

# --- 2. OSM input: plain Morocco, or Morocco + osmium-merged extras --------
MOROCCO_PBF="${WORK_DIR}/morocco-latest.osm.pbf"
download "${MOROCCO_PBF_URL}" "${MOROCCO_PBF}"

OSM_INPUT="${MOROCCO_PBF}"
if [ -n "${EXTRA_PBF_URLS}" ]; then
  log "EXTRA_PBF_URLS set — osmium-merging supplementary extracts into Morocco"
  MERGE_INPUTS=("${MOROCCO_PBF}")
  i=0
  # shellcheck disable=SC2086  # intentional word-split: EXTRA_PBF_URLS is a space-separated list
  for extra_url in ${EXTRA_PBF_URLS}; do
    i=$((i + 1))
    extra_dest="${WORK_DIR}/extra-${i}.osm.pbf"
    download "${extra_url}" "${extra_dest}"
    MERGE_INPUTS+=("${extra_dest}")
  done
  OSM_INPUT="${WORK_DIR}/morocco-full.osm.pbf"
  # osmium merge deduplicates overlapping objects across the inputs.
  osmium merge "${MERGE_INPUTS[@]}" --overwrite -o "${OSM_INPUT}"
else
  log "single-source build: Morocco extract already covers Western Sahara (min-lat ~20.88°N)"
fi

# --- 3. Planetiler → OpenMapTiles-schema .pmtiles --------------------------
# Default profile = OpenMapTiles (no --profile needed). --download fetches the
# auxiliary sources Planetiler needs (Natural Earth, water polygons, lake
# centerlines); --osm-path supplies our OSM data so those are the ONLY downloads.
# --force overwrites a prior output.
PLANETILER_ARGS=(
  "-Xmx${XMX}"
  -jar "${PLANETILER_JAR}"
  --osm-path="${OSM_INPUT}"
  --download
  --output="${OUTPUT_PATH}"
  --force
)

if [ "${WITH_WESTERN_SAHARA}" = "0" ]; then
  log "WITH_WESTERN_SAHARA=0 — clipping OUTPUT to Morocco-proper bbox ${MOROCCO_PROPER_BBOX}"
  PLANETILER_ARGS+=(--bounds="${MOROCCO_PROPER_BBOX}")
else
  log "WITH_WESTERN_SAHARA=1 (default) — building full extent (Western Sahara included)"
fi

log "running Planetiler → ${OUTPUT_PATH}"
java "${PLANETILER_ARGS[@]}"

# --- 4. Report --------------------------------------------------------------
[ -f "${OUTPUT_PATH}" ] || die "Planetiler finished but ${OUTPUT_PATH} is missing"
log "DONE. Output size:"
du -h "${OUTPUT_PATH}"
echo
echo "Expected ~150-900 MB (the CI sanity gate enforces this range)."
echo "Next: vendor the Liberty style, then bundle + publish the Release:"
echo "  node ./scripts/vendor-liberty-style.mjs      (run from the repo root)"
echo "  (CI does all of this automatically — see .github/workflows/build.yml)"
