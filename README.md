# linefleet-map-data

Offline Morocco basemap artifacts for LINEFLEET (fleet-management SaaS).

- **morocco.pmtiles** — OpenMapTiles-schema vector tiles built with [Planetiler](https://github.com/onthegomap/planetiler) from the [Geofabrik Morocco extract](https://download.geofabrik.de/africa/morocco.html). Data © OpenStreetMap contributors (ODbL); cartography © OpenMapTiles (CC-BY).
- **liberty style + fonts + sprites** — vendored from [OpenFreeMap](https://github.com/hyperknot/openfreemap-styles) (MIT), URL-rewritten for offline serving.

Bundles are published as Release assets (`tiles-data-<BUILD_ID>.tar.gz`) and consumed by the deployment via a checksum-verified populate step. Rebuilt monthly from fresh OSM data by the Actions workflow below.

Maps made with these tiles display: © OpenMapTiles © OpenStreetMap contributors

## Automated monthly rebuild (`.github/workflows/build.yml`)

**This repo is where the PRODUCTION rebuild runs.** The scripts in `scripts/` and
`config.json` are synced copies of the main LINEFLEET repo's `docker/tiles/`
(the dev/local twins) — keep the pair in sync when editing either side.

The workflow runs on the **1st of every month at 02:30 UTC** (plus manual
`workflow_dispatch`) and is **fully token-less** — its own `GITHUB_TOKEN`
creates the Release in this repo; no PAT or secret exists anywhere.

What it does:

1. **Build** `morocco.pmtiles` with Planetiler **pinned at v0.10.2** from
   `morocco-latest.osm.pbf` (fresh Geofabrik download every run — that IS the
   freshness mechanism). Western Sahara is included (the Geofabrik Morocco
   extract already reaches ~20.88°N).
2. **Vendor** the OpenFreeMap Liberty style + glyphs + sprites, apply the
   « carte officielle du Maroc » patch (twin of the main repo's
   `apps/web/src/lib/map-style.ts`), rewrite all URLs paths-relative, and run
   the offline guard (any leftover remote URL fails the build).
3. **Sanity gates** before anything is published:
   - pmtiles size within **150–900 MB** (tiny/huge = something broke);
   - **no `http(s)://` remnant** in the vendored style (offline guarantee);
   - **`boundary_disputed` absent** from the style (official-view patch held);
   - **`sprite == "liberty"`** and **`glyphs == "{fontstack}/{range}.pbf"`**
     (paths-RELATIVE — regression pins for the two 2026-07-17 staging bugs
     where a doubled path segment 500'd every static render).
4. **Assemble** the bundle (layout contract below), `tar -czf`, `sha256sum`.
5. **Publish a Release** `tiles-<BUILD_ID>` with TWO assets:
   `tiles-data-<BUILD_ID>.tar.gz` **and** `tiles-data-<BUILD_ID>.tar.gz.sha256`
   (the VPS apply step verifies the checksum FAIL-CLOSED). `BUILD_ID` is the
   run's UTC `YYYYMMDD`, letter-suffixed (`b`, `c`, …) if the tag already
   exists (e.g. `20260717b`).

Trigger manually:

```bash
gh workflow run build.yml --repo Deadlinemaroc/linefleet-map-data
gh run watch --repo Deadlinemaroc/linefleet-map-data   # ~15–25 min end-to-end
```

### Failure notification & keep-alive

- GitHub **emails the repo owner when a scheduled workflow run fails** (default
  notification behaviour) — a red run is not silent.
- **Cron auto-disable:** GitHub disables scheduled workflows on public repos
  after **60 days without repo activity** (commits/issues). The monthly Release
  is commit-less and does **NOT** count as activity. The keep-alive is
  **apply-side**: the consuming side alerts when the newest release is
  **> 45 days old** — when that fires, rebuild manually with
  `gh workflow run build.yml` (which also re-enables the schedule if it was
  disabled: any push/manual interaction resets the inactivity clock).

### Versioned-pair rule (planetiler ↔ Liberty style)

The pmtiles (OpenMapTiles schema emitted by the **pinned** Planetiler) and the
vendored Liberty style are a **versioned pair**: a newer style can reference
layers/attributes absent from an older schema, and vice-versa. **Never** switch
the workflow to "latest". To bump: change `PLANETILER_VERSION` in
`.github/workflows/build.yml` (and the default in
`scripts/build-morocco-pmtiles.sh` + the main-repo twin) **together with**
re-verifying the vendored style, then do a **visual smoke test** of the
resulting bundle (serve it with tileserver-gl, render a Casablanca static PNG —
see the main repo's `docker/tiles/README.md` Step 5) before pointing staging at
the new release.

### Bundle layout contract

One top-level dir (stripped on extraction); the inner layout must land exactly
where `config.json` expects it under `/data`:

```
tiles-data/
  config.json                       # tileserver-gl config (repo root, committed)
  data/morocco.pmtiles              # Planetiler output
  styles/liberty.json               # vendored + official-view patched
  fonts/<fontstack>/<range>.pbf     # vendored glyphs (Latin + Arabic)
  sprites/liberty.{json,png} + @2x  # vendored sprites
```

### How the VPS consumes releases

The deployment's `tiles-populate` one-shot (see the main LINEFLEET repo,
`docker/tiles/README.md` Steps 3–4) downloads the Release asset **token-less**
(public repo — deliberate: the bundle is ODbL OSM data + MIT style assets,
nothing proprietary), verifies `sha256sum -c` **fail-closed** (mismatch =
nothing extracted, tileserver won't start on a fresh volume), extracts into the
sidecar volume and stamps `/data/BUILD_ID`. To ship a new map, update the three
Coolify envs (`TILES_BUNDLE_URL`, `TILES_BUNDLE_SHA256`, `TILES_BUILD_ID`) and
redeploy; also bump the worker's `VIDEO_BASEMAP_BUILD_ID` so cached basemap
PNGs from the old map are never reused.

## Local build (dev)

Same scripts, run from the repo root (Java 21+, Node 18+):

```bash
WORK_DIR=/tmp/linefleet-tiles ./scripts/build-morocco-pmtiles.sh   # space-free WORK_DIR!
node ./scripts/vendor-liberty-style.mjs
```

Outputs land in `$WORK_DIR/morocco.pmtiles` and `assets/` (both git-ignored).
