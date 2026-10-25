#!/usr/bin/env bash
# Clones the Rolldown branch with `experimental.chunkImportMap.include` into
# vendor/rolldown and builds the native binding in release mode.
# Needs: git, pnpm, a Rust toolchain (rustup installs the pinned version).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${ROLLDOWN_DIR:-$ROOT/vendor/rolldown}"
REPO="https://github.com/iAmNathanJ/rolldown.git"
BRANCH="feat/chunk-import-map-include"
COMMIT="a77fcbb0d55c200cd1c9a30c83d41e8301b0904b"
PNPM="${PNPM:-pnpm}"
# The Rolldown repository pins a pnpm version in `packageManager`. Do not let
# pnpm download and switch to it; any pnpm 10 or later reads the lockfile.
export npm_config_manage_package_manager_versions=false

if [ ! -d "$DEST/.git" ]; then
  git clone --branch "$BRANCH" "$REPO" "$DEST"
fi
# Fetch by URL: an existing checkout may have a different origin.
git -C "$DEST" fetch --quiet "$REPO" "$BRANCH"
git -C "$DEST" checkout --quiet "$COMMIT"

cd "$DEST"
"$PNPM" install --frozen-lockfile --ignore-scripts --filter rolldown... --filter .
"$PNPM" -C packages/rolldown build-native:release

echo
echo "Built $DEST/packages/rolldown. Now run: cd proposed && pnpm install"
