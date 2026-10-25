// The same subset aliased by Rolldown, with `experimental.chunkImportMap.include`.
import path from 'node:path';

import {ALIASED, appDir, codeSplitting, resolveOutDir} from '../shared/chunks.mjs';

export default {
  root: appDir,
  base: '/',
  logLevel: 'warn',
  build: {
    outDir: resolveOutDir(import.meta.dirname),
    emptyOutDir: true,
    minify: true,
    sourcemap: 'hidden',
    manifest: true,
    chunkImportMap: true,
    rolldownOptions: {
      input: {main: path.join(appDir, 'main.js')},
      experimental: {
        chunkImportMap: {
          fileName: 'importmap.json',
          include: (chunk) => ALIASED.has(chunk.name),
        },
      },
      output: {
        hashCharacters: 'hex',
        // Importers reference the aliased chunks' exports by name across builds.
        minifyInternalExports: false,
        chunkFileNames: '[name]-[hash:12].js',
        entryFileNames: 'assets/[name]-[hash:12].js',
        codeSplitting,
      },
    },
  },
};
