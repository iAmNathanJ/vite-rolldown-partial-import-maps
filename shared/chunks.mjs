// Shared by both configurations so that the chunk graph is the same in each.
import fs from 'node:fs';
import path from 'node:path';

/** Chunks that get a stable name in the import map. */
export const ALIASED = new Set(['main', 'common', 'slice']);

export const appDir = fs.realpathSync(
  process.env.APP_DIR ?? path.resolve(import.meta.dirname, '../app'),
);

export function resolveOutDir(configDir) {
  return path.resolve(configDir, process.env.OUT_DIR ?? 'dist');
}

/**
 * One chunk per application module. The entry (`main`) and the dynamic import
 * targets (`editor`, `slice`) are chunks on their own. The other modules would
 * be merged into their only importer, so each gets a group.
 */
const SEPARATE = new Set(['page', 'common', 'vendor', 'util', 'settings']);

function chunkName(id) {
  if (!id.startsWith(`${appDir}${path.sep}`)) return null;
  // A CSS import is a module too. Keep it with the module that imports it.
  const name = path.basename(id).replace(/\.(js|css)$/, '');
  return SEPARATE.has(name) ? name : null;
}

export const codeSplitting = {
  minSize: 0,
  groups: [
    {
      debugName: 'one-chunk-per-module',
      name: chunkName,
      minSize: 0,
      priority: 10,
      includeDependenciesRecursively: false,
    },
  ],
};
