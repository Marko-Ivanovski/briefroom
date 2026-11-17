#!/bin/sh
set -eu

dir="${BRIEFROOM_DATA_DIR:-/data}"
probe="$dir/.briefroom-write-test"
if ! (: > "$probe") 2>/dev/null; then
  echo "Briefroom cannot write to $dir as uid $(id -u). Give that user the folder, or use a named volume." >&2
  exit 1
fi
rm -f "$probe"

exec "$@"
