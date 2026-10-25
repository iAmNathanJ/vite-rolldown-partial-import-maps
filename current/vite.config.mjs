// How we give a subset of chunks stable names today, in userland: plugins on stock Vite 8
// and stock Rolldown.
import path from 'node:path';

import {
  MAPPED,
  appDir,
  codeSplitting,
  resolveOutDir,
} from '../shared/chunks.mjs';
import {hashDepsPlugin} from './plugins/hash-deps.mjs';
import {importMapManifestPlugin} from './plugins/import-map-manifest.mjs';

const stableFileName = new RegExp(
  `^(assets/)?(${[...MAPPED].join('|')})\\.js$`,
);

export default {
  root: appDir,
  base: '/',
  logLevel: 'warn',
  plugins: [
    importMapManifestPlugin({mapped: MAPPED}),
    hashDepsPlugin(),
  ],
  build: {
    outDir: resolveOutDir(import.meta.dirname),
    emptyOutDir: true,
    minify: true,
    sourcemap: 'hidden',
    modulePreload: {
      // The stable file does not exist after the rename, and the import map
      // does not apply to a <link rel="modulepreload"> URL.
      resolveDependencies: (_url, deps) =>
        deps.filter((dep) => !stableFileName.test(dep)),
    },
    rolldownOptions: {
      input: {main: path.join(appDir, 'main.js')},
      output: {
        hashCharacters: 'hex',
        // Importers reference the mapped chunks' exports by name across builds.
        minifyInternalExports: false,
        // The mapped chunks get names without a hash. A plugin hashes and
        // renames them after the build.
        chunkFileNames: (chunk) =>
          MAPPED.has(chunk.name)
            ? `${chunk.name}.js`
            : `${chunk.name}-[hash:12].js`,
        entryFileNames: (chunk) =>
          MAPPED.has(chunk.name)
            ? `assets/${chunk.name}.js`
            : `assets/${chunk.name}-[hash:12].js`,
        codeSplitting,
        // hash-deps.mjs relies on legal comments surviving minification.
        comments: {legal: true},
      },
    },
  },
};
