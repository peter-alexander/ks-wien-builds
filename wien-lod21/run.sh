#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
SOURCE_DIR="$BUILD_DIR/source"
OUTPUT_DIR="$BUILD_DIR/WienBuildingsLOD21"
TARGETS_FILE="${WIEN_LOD21_TARGETS:-$SCRIPT_DIR/targets.pilot.json}"
HYBRID_CURRENT_FILE="$BUILD_DIR/hybrid-current.json"
DOWNLOAD_DIR="${WIEN_LOD21_DOWNLOAD_DIR:-$BUILD_DIR/downloads}"

# Preserve validated ZIPs across invocations in the same workspace.
rm -rf "$SOURCE_DIR" "$OUTPUT_DIR"
rm -f "$HYBRID_CURRENT_FILE"
mkdir -p "$BUILD_DIR" "$SOURCE_DIR" "$OUTPUT_DIR" "$DOWNLOAD_DIR"

node --check "$SCRIPT_DIR/build.mjs"
node --check "$SCRIPT_DIR/fetch-hybrid-current.mjs"
node --check "$SCRIPT_DIR/validate-production.mjs"
node --check "$SCRIPT_DIR/download-sheets.mjs"

if [ "${WIEN_LOD21_SKIP_DOWNLOAD:-0}" = "1" ]; then
	echo "Use previously collected LOD2.1 source ZIPs: $DOWNLOAD_DIR"
else
	node "$SCRIPT_DIR/download-sheets.mjs" \
		--targets "$TARGETS_FILE" \
		--cache-dir "$DOWNLOAD_DIR" \
		--summary "$BUILD_DIR/download-report.json"
fi

mapfile -t SHEETS < <(
	node --input-type=module - "$TARGETS_FILE" <<'NODE'
import fs from "node:fs";
const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
for (const sheet of [...new Set((input.buildings || []).map((item) => String(item.sheet)))].sort()) {
	console.log(sheet);
}
NODE
)

for sheet in "${SHEETS[@]}"; do
	unzip -q "$DOWNLOAD_DIR/${sheet}_lod2_gml.zip" -d "$SOURCE_DIR"
done

node "$SCRIPT_DIR/fetch-hybrid-current.mjs" \
	--targets "$TARGETS_FILE" \
	--output "$HYBRID_CURRENT_FILE"

node --expose-gc "$SCRIPT_DIR/build.mjs" \
	--input "$SOURCE_DIR" \
	--output "$OUTPUT_DIR" \
	--targets "$TARGETS_FILE" \
	--hybrid-current "$HYBRID_CURRENT_FILE"

echo "Vienna LOD2.1 build complete:"
find "$OUTPUT_DIR" -type f -printf '%P %s bytes\n' | sort
