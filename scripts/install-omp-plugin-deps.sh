#!/usr/bin/env bash
# Install runtime dependencies in omp's flat cache (and older nested caches).
set -uo pipefail

cache_root=${1:?usage: install-omp-plugin-deps.sh CACHE_ROOT [--dry-run]}
dry_run=${2:-}
failed=0

for dir in "$cache_root"/*/ "$cache_root"/*/*/; do
  [ -f "$dir/package.json" ] || continue
  python3 -c 'import json,sys; p=json.load(open(sys.argv[1])); sys.exit(0 if p.get("dependencies") else 1)' "$dir/package.json" 2>/dev/null
  manifest_status=$?
  if [ "$manifest_status" -gt 1 ]; then
    echo "  FAILED    $dir (invalid package.json)"
    failed=1
    continue
  fi
  [ "$manifest_status" -eq 0 ] || continue
  if [ "$dry_run" = "--dry-run" ]; then
    echo "  would install dependencies: $dir"
    continue
  fi
  # A directory alone does not prove an earlier install completed. Bun's own
  # install is idempotent and repairs incomplete dependency trees.
  echo "  install   $(basename "$dir")"
  (cd "$dir" && bun install --production) || failed=1
done

exit "$failed"
