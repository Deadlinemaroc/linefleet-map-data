/** Separate permissively licensed points; never merge them into OSM addresses. */
export function withPlaceOverlay(input) {
  const style = structuredClone(input);
  if (style.sources["linefleet-places"]) return style;
  const template = style.layers.find((layer) => layer.id === "poi_r1" && layer.type === "symbol");
  if (!template) throw new Error("Liberty POI layer missing; review the style/schema pair");
  style.sources["linefleet-places"] = {
    type: "vector", url: "mbtiles://{places}",
    attribution: "© Overture Maps Foundation · Meta / Microsoft / AllThePlaces",
  };
  const layer = structuredClone(template);
  layer.id = "poi_overture";
  layer.source = "linefleet-places";
  layer.minzoom = 15;
  delete layer.filter;
  delete layer.layout["icon-image"];
  layer.layout["text-field"] = ["get", "name"];
  layer.layout["text-allow-overlap"] = false;
  layer.layout["text-ignore-placement"] = false;
  layer.layout["text-padding"] = 4;
  layer.layout["text-size"] = 11;
  layer.layout["text-offset"] = [0, 0];
  layer.layout["text-anchor"] = "center";
  // Resolve the best-supported points first without forcing overlapping labels.
  layer.layout["symbol-sort-key"] = ["-", 1, ["get", "confidence"]];
  style.layers.splice(style.layers.indexOf(template), 0, layer);
  return style;
}
