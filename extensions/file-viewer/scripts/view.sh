#!/usr/bin/env bash
# Trigger file viewer from any agent session.
# Usage: bash scripts/view.sh <path>[:line]
#
# Writes a trigger file that the file-viewer extension picks up on session_start
# or via a polling check.

FILE_PATH="${1:-.}"
LINE=""

if [[ "$FILE_PATH" == *:* ]]; then
	LINE="${FILE_PATH##*:}"
	FILE_PATH="${FILE_PATH%:*}"
fi

# Resolve relative to cwd
RESOLVED="$(cd "$(dirname "$FILE_PATH")" 2>/dev/null && pwd)/$(basename "$FILE_PATH")"

if [[ ! -e "$RESOLVED" ]]; then
	echo "Error: not found: $FILE_PATH" >&2
	exit 1
fi

# Write trigger to .pi/view-trigger.json
TRIGGER_DIR=".pi"
mkdir -p "$TRIGGER_DIR"

cat > "$TRIGGER_DIR/view-trigger.json" << ENDJSON
{
  "path": "$RESOLVED",
  "line": ${LINE:-null},
  "requestedAt": $(date +%s000)
}
ENDJSON

echo "View trigger written. Run /view-trigger or reload to open."
