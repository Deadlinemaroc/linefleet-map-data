# linefleet-map-data

Offline Morocco basemap artifacts for LINEFLEET (fleet-management SaaS).

- **morocco.pmtiles** — OpenMapTiles-schema vector tiles built with [Planetiler](https://github.com/onthegomap/planetiler) from the [Geofabrik Morocco extract](https://download.geofabrik.de/africa/morocco.html). Data © OpenStreetMap contributors (ODbL); cartography © OpenMapTiles (CC-BY).
- **liberty style + fonts + sprites** — vendored from [OpenFreeMap](https://github.com/hyperknot/openfreemap-styles) (MIT), URL-rewritten for offline serving.

Bundles are published as Release assets (tiles-data-YYYYMMDD.tar.gz) and consumed by the deployment via a checksum-verified populate step. Rebuilt periodically from fresh OSM data.

Maps made with these tiles display: © OpenMapTiles © OpenStreetMap contributors
