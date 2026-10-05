#!/usr/bin/env node
import { openSync, readSync, closeSync } from "node:fs";
import { gunzipSync } from "node:zlib";

// Read only the tiny PMTiles metadata block, never the whole country in RAM.
const fd = openSync(process.argv[2], "r");
try {
  const header = Buffer.alloc(127);
  readSync(fd, header, 0, header.length, 0);
  if (header.toString("utf8", 0, 7) !== "PMTiles" || header[7] !== 3) throw new Error("Expected PMTiles v3");
  const offset = Number(header.readBigUInt64LE(24));
  const length = Number(header.readBigUInt64LE(32));
  if (!Number.isSafeInteger(offset) || length < 1 || length > 1_000_000) throw new Error("Invalid metadata size");
  const data = Buffer.alloc(length);
  readSync(fd, data, 0, length, offset);
  if (![1, 2].includes(header[97])) throw new Error("Unsupported metadata compression");
  const metadata = JSON.parse((header[97] === 2 ? gunzipSync(data) : data).toString("utf8"));
  const dataDate = metadata["planetiler:osm:osmosisreplicationtime"];
  if (!dataDate || !Number.isFinite(Date.parse(dataDate))) throw new Error("Missing OSM extract timestamp");
  const age = Date.now() - Date.parse(dataDate);
  if (age > 7 * 86_400_000 || age < -86_400_000) throw new Error("Extract is not current; refusing release");
  console.log(JSON.stringify({ dataDate: new Date(dataDate).toISOString(), source: "Geofabrik Morocco / OpenStreetMap", planetiler: metadata["planetiler:version"] ?? null }));
} finally { closeSync(fd); }
