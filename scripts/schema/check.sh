#!/usr/bin/env sh
# The schema has three copies that must agree: the spec, schema.ts and docs/storage/schema.md.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
"$root/scripts/schema/codegen/diff-schema.sh" "$root"
page=$(mktemp)
trap 'rm -f "$page"' EXIT
node "$root/scripts/schema/render.mjs" "$page"
diff -u "$root/docs/storage/schema.md" "$page" || { echo "docs/storage/schema.md is stale: pnpm schema:render" >&2; exit 1; }
echo "docs/storage/schema.md matches the spec"
