#!/usr/bin/env bash
# build-world-pmtiles.sh — build the WORLD low-zoom basemap (world.pmtiles) that
# lets the app zoom out from the national tiles to the whole planet without a
# void. Planetiler, OpenMapTiles schema (Liberty parity), zooms 0–7 only:
# coastlines, oceans and lakes (Natural Earth at z0–5, OSM water polygons at
# z6–7), ice. The OSM input is a TINY remote extract (Pitcairn) because the
# profile needs one; no national data is duplicated, no country borders are
# rendered from it (the style draws none), so nothing here can show a separation
# inside the national territory. Country names come from a curated inline list
# (build-world-labels.mjs), never from this tileset.
#
#   WORK_DIR=/tmp/linefleet-tiles ./build-world-pmtiles.sh      # ~70–120 MB out
#
# Shares the pinned Planetiler version and the download cache with
# build-morocco-pmtiles.sh (same WORK_DIR ⇒ Natural Earth / water polygons are
# downloaded once).
set -euo pipefail

PLANETILER_VERSION="${PLANETILER_VERSION:-v0.10.2}"
WORLD_OSM_URL="${WORLD_OSM_URL:-https://download.geofabrik.de/australia-oceania/pitcairn-islands-latest.osm.pbf}"
WORLD_MAXZOOM="${WORLD_MAXZOOM:-7}"
OUTPUT_NAME="${OUTPUT_NAME:-world.pmtiles}"
XMX="${XMX:-4g}"
WORK_DIR="${WORK_DIR:-./build}"
PLANETILER_JAR_URL="https://github.com/onthegomap/planetiler/releases/download/${PLANETILER_VERSION}/planetiler.jar"

log() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }
download() {
  local url="$1" dest="$2"
  if [ -f "${dest}" ]; then log "already present, skipping download: ${dest}"; return 0; fi
  log "downloading ${url}"
  curl -fSL --max-redirs 5 --retry 3 --connect-timeout 30 -o "${dest}.part" "${url}"
  mv "${dest}.part" "${dest}"
}

need java
need curl
JAVA_MAJOR="$(java -version 2>&1 | awk -F'"' '/version/ {print $2}' | awk -F. '{print ($1=="1"?$2:$1)}')"
[ -n "${JAVA_MAJOR}" ] && [ "${JAVA_MAJOR}" -ge 21 ] 2>/dev/null || die "Java 21+ required"

mkdir -p "${WORK_DIR}"
WORK_DIR="$(cd "${WORK_DIR}" && pwd)"
case "${WORK_DIR}" in *[[:space:]]*) die "WORK_DIR '${WORK_DIR}' contains spaces — Planetiler parses --output as a URI";; esac
cd "${WORK_DIR}"

PLANETILER_JAR="${WORK_DIR}/planetiler-${PLANETILER_VERSION}.jar"
OSM_INPUT="${WORK_DIR}/world-seed.osm.pbf"
OUTPUT_PATH="${WORK_DIR}/${OUTPUT_NAME}"

download "${PLANETILER_JAR_URL}" "${PLANETILER_JAR}"
download "${WORLD_OSM_URL}" "${OSM_INPUT}"

log "running Planetiler (world, z0–${WORLD_MAXZOOM}) → ${OUTPUT_PATH}"
java "-Xmx${XMX}" -jar "${PLANETILER_JAR}" \
  --osm-path="${OSM_INPUT}" \
  --download \
  --bounds=world \
  --maxzoom="${WORLD_MAXZOOM}" \
  --output="${OUTPUT_PATH}" \
  --force

[ -f "${OUTPUT_PATH}" ] || die "Planetiler finished but ${OUTPUT_PATH} is missing"
log "DONE. Output size:"; du -h "${OUTPUT_PATH}"
