// A reduced version of the manifest plugin we run in production. It has two jobs.
//
// 1. renderChunk + augmentChunkHash. The aliased chunks have no hash in their
//    file name, so the bundler's hash graph does not cover anything behind them.
//    Vite's __vite__mapDeps lists the CSS behind them and is written after
//    hashing. This adds that CSS to each importer's hash.
//
//    Rolldown calls renderChunk for all chunks concurrently. The plugin stores
//    each chunk's metadata, then waits until the metadata for the chunk's import
//    tree exists before it computes the augmentation.
//
// 2. writeBundle. Hash the content of the aliased chunks, rename them on disk,
//    and write the import map and integrity hashes to manifest.json. The server
//    inlines the import map into the HTML document.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function importMapManifestPlugin({aliased}) {
  const metadata = new Map(); // fileName -> {importedCss, imports}
  const ready = new Map(); // fileName -> Promise<void>
  const signal = new Map(); // fileName -> resolve
  const augmentations = new Map(); // fileName -> string
  let outDir;
  let base;

  function whenReady(fileName) {
    if (!ready.has(fileName)) {
      ready.set(
        fileName,
        new Promise((resolve) => signal.set(fileName, resolve)),
      );
    }
    return ready.get(fileName);
  }

  return {
    name: 'import-map-manifest',
    apply: 'build',
    enforce: 'post',

    configResolved(config) {
      outDir = config.build.outDir;
      base = config.base;
    },

    async renderChunk(_code, chunk) {
      metadata.set(chunk.fileName, {
        importedCss: [...(chunk.viteMetadata?.importedCss ?? [])],
        imports: [...chunk.imports],
      });
      whenReady(chunk.fileName);
      signal.get(chunk.fileName)();

      // Own CSS, then the CSS of static and dynamic imports, then static
      // imports transitively.
      const css = new Set(metadata.get(chunk.fileName).importedCss);
      const visited = new Set();
      async function walk(fileName) {
        if (visited.has(fileName)) return;
        visited.add(fileName);
        await whenReady(fileName);
        const entry = metadata.get(fileName);
        for (const file of entry.importedCss) css.add(file);
        for (const file of entry.imports) await walk(file);
      }
      for (const file of [...chunk.imports, ...chunk.dynamicImports])
        await walk(file);

      if (css.size > 0) {
        augmentations.set(chunk.fileName, `css:${[...css].sort().join(',')}`);
      }
      return null;
    },

    augmentChunkHash(chunk) {
      return augmentations.get(chunk.fileName);
    },

    writeBundle(_options, bundle) {
      const manifest = {entry: null, importMap: {imports: {}, integrity: {}}};
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk' || !aliased.has(chunk.name)) continue;

        const hash = crypto
          .createHash('sha256')
          .update(chunk.code)
          .digest('hex')
          .slice(0, 12);
        const mappedFileName = chunk.fileName.replace(/\.js$/, `-${hash}.js`);
        fs.renameSync(
          path.join(outDir, chunk.fileName),
          path.join(outDir, mappedFileName),
        );
        if (chunk.sourcemapFileName) {
          fs.renameSync(
            path.join(outDir, chunk.sourcemapFileName),
            path.join(outDir, `${mappedFileName}.map`),
          );
        }

        const from = base + chunk.fileName;
        const to = base + mappedFileName;
        manifest.importMap.imports[from] = to;
        manifest.importMap.integrity[to] = `sha256-${crypto
          .createHash('sha256')
          .update(chunk.code)
          .digest('base64')}`;
        if (chunk.isEntry) manifest.entry = to;
      }
      fs.writeFileSync(
        path.join(outDir, 'manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
    },
  };
}
