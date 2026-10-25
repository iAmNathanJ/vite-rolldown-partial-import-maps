# Partial chunk import maps

**Status:** proposal, with a working implementation on Rolldown `v1.2.14`.
**Rolldown change:** https://github.com/iAmNathanJ/rolldown/tree/feat/chunk-import-map-include (one commit).
**Vite change:** two lines in `vite:css-post` (see [Vite change](#vite-change)).
**Reduced test case:** https://github.com/iAmNathanJ/vite-rolldown-partial-import-maps (both configurations, a build matrix, and a browser demo).

## Proposal

Add `include` to Rolldown's `experimental.chunkImportMap`:

```ts
experimental: {
  chunkImportMap: {
    fileName: 'importmap.json',
    include: (chunk: PreRenderedChunk) => boolean,
  },
},
```

A chunk for which `include` returns `true` gets a stable alias. Importers reference it by alias, and the import map points the alias to the content-hashed file. All other chunks keep content-hashed names, and importers reference them by name. When `include` is not set, all chunks get an alias, as today.

An aliased chunk does not add its own content to the hash of its importers. It does add the hashed chunks that its static imports reach, through any chain of aliased chunks. This rule keeps file names correct when a tool writes dependency names into a chunk after hashing. Vite's module preload lists are one such tool.

Vite's `vite:css-post` plugin must alias the CSS of aliased chunks only.

## Our need

We build a single-page application with Vite. The build makes thousands of JavaScript chunks. We deploy them to a CDN with immutable, content-hashed file names.

A chunk's file name is a hash of its content and of the chunks it imports, because its code contains their file names. A change in a module that many chunks import renames those chunks, then their importers, and so on. Users download files whose only change is a file name inside them.

An import map stops this. Importers reference a shared chunk by a stable alias. A change in the shared chunk then changes only that file and the import map. We inline the import map in the HTML document, which is not cached.

We alias a small set of chunks: the runtime, shared vendor code, the router, and some application-wide chunks. Most import paths go through these chunks. Rolldown's `chunkImportMap` aliases all chunks. An import map with an entry for each of our chunks is too large for us to inline in each HTML document.

### How we alias a subset today

Rolldown has no option to alias a subset. We do it with plugins:

- `chunkFileNames` gives the selected chunks names without a hash, for example `common.js`.
- After the build, a plugin hashes the content of these files, renames them to `common-<hash>.js`, and writes the import map and integrity hashes to a manifest. The server inlines the manifest.
- `modulePreload.resolveDependencies` removes the unhashed chunks from preload lists. The unhashed file does not exist after the rename, and the import map does not apply to a `<link rel="modulepreload">` URL.
- `augmentChunkHash` adds the CSS behind the unhashed chunks to the hashes of their importers. Rolldown calls `renderChunk` for all chunks concurrently, so the plugin must wait for the metadata of each chunk's import tree before it computes the augmentation.
- `minifyInternalExports: false`, so the export names of the unhashed chunks do not change when their content changes.

### The hash gap

Vite writes each chunk's preload list (`__vite__mapDeps`) in `generateBundle`, after Rolldown has hashed the chunk. The list contains the final file names of the static imports of each dynamic import target. The chunk's hash covers only the names that were placeholders in its code before hashing.

Example: `page → import('./editor') → common (unhashed) → vendor`.

- `page` has a placeholder for `editor`. The hash of `page` depends on `editor`.
- `editor` references `common.js` by name, not by placeholder. The hash of `editor` does not depend on `common` or on `vendor`.
- Vite's preload list for `import('./editor')` contains the final name of `vendor`. Vite writes it into `page`.

When `vendor` changes, the bytes of `page` change but its file name does not. The CDN continues to serve the old file.

```diff
 // page-ede086a1b085.js, before and after `common` stops importing `vendor`
 const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["editor-138953dae218.js",
-"vendor-5af16780cc6c.js",
 "util-e112b1dd33ed.js","assets/main-3012a5fd.css","assets/editor-cc02449e.css",
 "settings-769cee2becd6.js","assets/slice-1ee31b2a.css"])))=>i.map(i=>d[i]);
```

Rollup hides this gap in most cases. Its `hoistTransitiveImports` option (default `true`) adds `import "./dep-<hash>.js"` for each transitive static import of a dynamic import target, so the target has placeholders for the chunks behind the unhashed chunk. Rolldown declares `hoistTransitiveImports` but does not implement it. One case shows on Rollup too: a hashed chunk that dynamically imports an unhashed chunk directly.

We can close the gap with more `augmentChunkHash` code in our plugins. We think the bundler is the correct place for the rule, because the bundler owns the hash graph.

## Hashing rule

Rolldown hashes chunks as Rollup does. Each chunk is rendered with placeholders for its own name and for the names of the chunks it references. The standalone hash of a chunk is a hash of its content with placeholders normalized, plus `augmentChunkHash` output. The final hash of a chunk is its standalone hash plus the standalone hashes of the chunks its placeholders reach, transitively.

Today's `chunkImportMap` plugin replaces all placeholders with aliases in a `renderChunk` hook before hashing. No placeholder remains, so the dependency graph is empty and each name depends on that chunk's bytes only. This cannot apply to a subset without a new rule.

The rule: read the dependency graph from the original placeholders. Replace each edge to an aliased chunk with edges to the hashed chunks that its static imports reach. Then compute final hashes as before. The aliased chunk's own file still gets a content hash, and the import map points to it. When all chunks are aliased, no edges remain and the result is the same as today.

### Why static imports

The rule follows the static imports of an aliased chunk, not its dynamic imports. A shared chunk in our application dynamically imports a large part of the application. If importers inherited the dynamic imports, a change anywhere in that part would rename each importer of the shared chunk with its bytes unchanged. In our build, this renamed a large part of the output with no byte change.

The static imports of a chunk are the chunks that must load before it runs. Tools that write "what this chunk needs" into other chunks use this set: Rollup's `hoistTransitiveImports`, module preload lists, `<link rel="modulepreload">` injection, early hints, and asset manifests. A chunk resolves its dynamic imports itself, at run time, from its own content. Those names do not appear in importers. So the static closure is the set of names behind an alias that can appear in an importer's bytes, and it is the set the importer's hash must cover.

### Alias identity

An alias is the chunk's preliminary file name with the hash slot filled by an identity hash of the same width: `common-!~{003}~.js` becomes `common-5f5f2b1ff4d0.js`. Same width keeps sourcemaps correct, because substitution happens after sourcemap generation.

The identity is a hash of `(is_path, id)`. For an entry chunk, `id` is the facade module id, made relative to `cwd` when it is a filesystem path. For a named common chunk, `id` is the chunk name. A later common chunk with the same name uses the smallest key among its original members. This is the scheme of [rolldown/rolldown#11277](https://github.com/rolldown/rolldown/pull/11277), the fix for [#11279](https://github.com/rolldown/rolldown/issues/11279). If #11277 merges first, this part of the change is removed.

## Vite change

`vite:css-post` adds an import-map entry for each chunk's CSS when `build.chunkImportMap` is on. When the chunk has no alias, it falls back to the chunk's real file name. With a subset aliased, the fallback makes an entry for each chunk with CSS and writes alias-shaped CSS names into preload lists. The fix skips chunks without an alias:

```diff
 for (const [chunkFileName, referenceId] of chunkCssReferences) {
   const chunk = chunksByPreliminaryFileName.get(chunkFileName)
   if (!chunk) continue
-  const stableChunkFileName = importMapReverseMapping[chunk.fileName] ?? chunk.fileName
+  const stableChunkFileName = importMapReverseMapping[chunk.fileName]
+  if (stableChunkFileName === undefined) continue
   const extension = path.posix.extname(stableChunkFileName)
```

For aliased chunks, the CSS alias is correct. CSS assets are not placeholders, so the hashing rule does not cover them. The CSS alias ties the CSS name to the chunk identity and the import map resolves it. When all chunks are aliased, the change has no effect.

## Results

### Reduced test case

Eight modules, three aliased, built with Vite 8.3.4, minified, hidden sourcemaps. Each row changes one module between two builds and compares the `page` chunk, the importer whose preload lists change. The repository also runs the hand-made fix (`FIX=1`), which gives the same results as the proposal.

| change                                                      | hand-rolled subset on stock Rolldown | this proposal         |
| ----------------------------------------------------------- | ------------------------------------ | --------------------- |
| `common` stops importing `vendor`                           | **same name, different bytes**       | new name              |
| `vendor` changes                                            | **same name, different bytes**       | new name              |
| `settings` changes (behind the dynamically imported, aliased `slice`) | **same name, different bytes** | new name              |
| `common` body changes, same imports                         | same name, same bytes                | same name, same bytes |
| `slice` body changes, same imports                          | same name, same bytes                | same name, same bytes |
| `util` changes (behind the hashed `editor`)                 | new name                             | new name              |

Builds are byte-for-byte identical across runs. Vite writes the alias into `__vite__mapDeps`, and its preload helper resolves the alias with `import.meta.resolve`. Preload lists need no rewrite and no filter.

### Production application

A one-line change in a module reached only through an aliased chunk:

|                                      | renamed files | byte-identical renames | same name, different bytes |
| ------------------------------------ | ------------- | ---------------------- | -------------------------- |
| hand-rolled subset on stock Rolldown | _n_           | 0                      | **1**                      |
| this proposal                        | _n_ + 4       | 0                      | **0**                      |

The four extra renames are the chunks whose preload lists name the changed module through an aliased chunk. Their bytes changed, so their names must change. Alias keys are identical across builds. Build time is unchanged with a release build of Rolldown.

With the proposal and with the plugins removed, the output is byte-identical to the stock output for all chunks, after normalization of the names the proposal changes: hashes in file names and references, the alias form of the shared chunks, and the alias entries in preload lists.

Served from a production-mode server with the import map inlined: each script and stylesheet loads. No request names an alias; the browser fetches content-hashed files only. Aliased chunks named in preload lists load once each as `modulepreload` before the dynamic import that needs them. There are no preload, integrity, or CSP errors.

## Implementation

One commit on `v1.2.14`, about 230 lines without test fixtures:

| file                                                                | change                                                                                                                                                               |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates/rolldown_common/.../chunk_import_map.rs`                    | `include: Option<Arc<dyn Fn(&RollupPreRenderedChunk) -> Future<bool>>>`; a shared `aliases` table written during hashing, read when emitting                         |
| `crates/rolldown/src/utils/chunk/chunk_import_map_aliases.rs` (new) | alias computation; same-width substitution; `static_dependencies_of_aliased` (from `cross_chunk_imports`); `collapse_aliased_dependencies`                           |
| `crates/rolldown/src/utils/chunk/finalize_chunks.rs`                | read the dependency graph from the original placeholders, substitute aliases, compute standalone hashes, collapse edges through aliased chunks, compute final hashes |
| `crates/rolldown_plugin_chunk_import_map/src/lib.rs`                | no `renderChunk` rewrite; emits `importmap.json` from the recorded aliases                                                                                           |
| `crates/rolldown_binding/...`                                       | `include` as a napi `JsCallback`, the same pattern as `chunkFileNames`                                                                                               |
| `packages/rolldown/src/...`                                         | TypeScript type, validator, bindingify                                                                                                                               |

A rebase onto current `main` conflicts in the plugin file only. Upstream reworked that file for inline common chunks in [#11230](https://github.com/rolldown/rolldown/pull/11230); the equivalent logic now lives in `finalize_assets`.

### Tests

`crates/rolldown/tests/rolldown/function/chunk_import_map_include/` builds variants of a six-module graph and compares pairs of outputs:

- the import map lists the included chunks only, alias to content-hashed name;
- importers reference aliased chunks by alias only, with no placeholder left;
- a change behind an aliased chunk renames the importer and keeps the aliases;
- a change to an aliased chunk's own body renames that file and its import map entry only;
- a change behind a dynamically imported aliased chunk renames the importer;
- a change to an aliased chunk's dynamic import target renames nothing else;
- aliases are identical across builds.

The existing integration suite passes. `cargo fmt` and `cargo clippy` are clean under the repository's lints.

## What we can remove

With the proposal, our build no longer needs:

- unhashed `chunkFileNames` for the shared chunks;
- post-build hashing and renaming of those chunks, and hand-built import-map construction (`importmap.json` replaces it);
- `augmentChunkHash` for CSS or JavaScript behind the shared chunks;
- the `modulePreload.resolveDependencies` filter. Vite writes the alias into `__vite__mapDeps` and resolves it with `import.meta.resolve` before it creates the link, so the link has the content-hashed URL. A build-time URL would make the importer's bytes depend on the aliased chunk's content again.

We still inline the import map and integrity hashes into the document.

## Open items

- **Export names.** We set `minifyInternalExports: false` for all chunks, because the exports of an aliased chunk must keep their names when its content changes. Rolldown could keep stable export names for aliased chunks only.
- **Alias template.** The alias keeps the `[name]-<hash>` form for the sourcemap reason above. A `[name].js` form would need padding or sourcemap remapping.
- **Escape hatch.** An option for aliased chunks to add no dependencies at all, for a build that runs no post-hash tooling.
- **`hoistTransitiveImports`.** Not implemented in Rolldown. It is independent of this proposal.

## Try it

```sh
git clone https://github.com/iAmNathanJ/rolldown.git && cd rolldown
git switch feat/chunk-import-map-include
pnpm install --filter rolldown...
cd packages/rolldown && pnpm build-native:release
# Point the `rolldown` package that Vite resolves at packages/rolldown.
```

Vite config:

```ts
build: {
  chunkImportMap: true,
  rolldownOptions: {
    experimental: { chunkImportMap: { include: (chunk) => SHARED_CHUNKS.has(chunk.name) } },
    output: { chunkFileNames: '[name]-[hash:12].js', entryFileNames: 'assets/[name]-[hash:12].js' },
  },
},
```
