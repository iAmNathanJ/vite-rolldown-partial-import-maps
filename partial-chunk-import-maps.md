# Partial chunk import maps

- **Rolldown change:** https://github.com/iAmNathanJ/rolldown/tree/feat/chunk-import-map-include (one commit).
- **Vite change:** two lines in `vite:css-post` (see [Vite change](#vite-change)).
- **Reduced test case:** https://github.com/iAmNathanJ/vite-rolldown-partial-import-maps (both configurations, a build matrix, and a browser demo).

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

A chunk for which `include` returns `true` gets a stable name. Importers reference it by that name, and the import map points the stable name to the content-hashed file. All other chunks keep content-hashed names, and importers reference them by name. When `include` is not set, all chunks get a stable name, as today.

A mapped chunk (a chunk with a stable name) does not add its own content to the hash of its importers. It does add the hashed chunks that its static imports reach, through any chain of mapped chunks. This rule keeps file names correct when a tool writes dependency names into a chunk after hashing. Vite's module preload lists are one such tool.

Vite's `vite:css-post` plugin must give a stable name to the CSS of mapped chunks only.

## Why?

We build a very large single-page application with Vite. The build makes thousands of JavaScript chunks. We deploy them to a CDN with immutable, content-hashed file names.

A chunk's file name is a hash of its content and of the chunks it imports, because its code contains their file names. A change in a module that many chunks import renames those chunks, then their importers, and so on. Users download files whose only change is a file name inside them.

An import map stops this. Importers reference a shared chunk by a stable name. A change in the shared chunk then changes only that file and the import map. We inline the import map in the HTML document, which is not cached.

We give a small set of chunks stable names: the runtime, shared vendor code, the router, and some application-wide chunks. Most import paths go through these chunks. Rolldown's `chunkImportMap` gives all chunks stable names. An import map with an entry for each of our chunks is too large for us to inline in each HTML document.

### How we map a subset today

Rolldown has no option to map a subset. We do it in userland, with configuration and plugins:

- `chunkFileNames` gives the selected chunks names without a hash, for example `common.js`.
- After the build, a plugin hashes the content of these files, renames them to `common-<hash>.js`, and writes the import map and integrity hashes to a manifest. The server inlines the manifest.
- `modulePreload.resolveDependencies` removes the unhashed chunks from preload lists. The unhashed file does not exist after the rename, and the import map does not apply to a `<link rel="modulepreload">` URL.
- `augmentChunkHash` adds the CSS behind the unhashed chunks to the hashes of their importers. Rolldown calls `renderChunk` for all chunks concurrently, so the plugin must wait for the metadata of each chunk's import tree before it computes the augmentation.
- A second `augmentChunkHash` plugin adds the JavaScript behind the unhashed chunks to the hashes of their importers. The next section explains why.
- `minifyInternalExports: false`, so the export names of the unhashed chunks do not change when their content changes.

### The hash gap

Vite writes each chunk's preload list (`__vite__mapDeps`) in `generateBundle`, after Rolldown has hashed the chunk. The list contains the final file names of the static imports of each dynamic import target. The chunk's hash covers only the names that were placeholders in its code before hashing.

Example: `page → import('./editor') → common (unhashed) → vendor`.

- `page` has a placeholder for `editor`. The hash of `page` depends on `editor`.
- `editor` references `common.js` by name, not by placeholder. The hash of `editor` does not depend on `common` or on `vendor`.
- Vite's preload list for `import('./editor')` contains the final name of `vendor`. Vite writes it into `page`.

When `vendor` changes, the bytes of `page` change but its file name does not. The CDN continues to serve the old file.

```diff
 // page-370856d843c0.js, before and after `common` stops importing `vendor`,
 // without the JavaScript augmentation
 const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["editor-219ec73e51be.js",
-"vendor-5af16780cc6c.js",
 "util-e112b1dd33ed.js","assets/common-3012a5fd.css","assets/editor-cc02449e.css",
 "settings-769cee2becd6.js","assets/slice-1ee31b2a.css"])))=>i.map(i=>d[i]);
```

Rollup hides this gap in most cases. Its `hoistTransitiveImports` option (default `true`) adds `import "./dep-<hash>.js"` for each transitive static import of a dynamic import target, so the target has placeholders for the chunks behind the unhashed chunk. Rolldown declares `hoistTransitiveImports` but does not implement it. One case shows on Rollup too: a hashed chunk that dynamically imports an unhashed chunk directly.

Our plugin closes the gap from outside the bundler. For each hashed chunk, it appends a legal comment that names, for each unhashed chunk it imports, the hashed chunks reached from there through unhashed chunks only. The names contain hash placeholders. Legal comments survive minification, so the bundler sees the placeholders when it hashes. The plugin removes the comment in `generateBundle`, when hashes are final.

This works, and it depends on two bundler internals: the placeholder format, and legal comments staying in place through minification. We think the bundler is the correct place for the rule, because the bundler owns the hash graph.

## Hashing rule

Rolldown hashes chunks as Rollup does. Each chunk is rendered with placeholders for its own name and for the names of the chunks it references. The standalone hash of a chunk is a hash of its content with placeholders normalized, plus `augmentChunkHash` output. The final hash of a chunk is its standalone hash plus the standalone hashes of the chunks its placeholders reach, transitively.

Today's `chunkImportMap` plugin replaces all placeholders with stable names in a `renderChunk` hook before hashing. No placeholder remains, so the dependency graph is empty and each name depends on that chunk's bytes only. This cannot apply to a subset without a new rule.

The rule: read the dependency graph from the original placeholders. Replace each edge to a mapped chunk with edges to the hashed chunks that its static imports reach. Then compute final hashes as before. The mapped chunk's own file still gets a content hash, and the import map points to it. When all chunks are mapped, no edges remain and the result is the same as today.

### Why static imports

The rule follows the static imports of a mapped chunk, not its dynamic imports. A shared chunk in our application dynamically imports a large part of the application. If importers inherited the dynamic imports, a change anywhere in that part would rename each importer of the shared chunk with its bytes unchanged. In our build, this renamed a large part of the output with no byte change.

The static imports of a chunk are the chunks that must load before it runs. Tools that write "what this chunk needs" into other chunks use this set: Rollup's `hoistTransitiveImports`, module preload lists, `<link rel="modulepreload">` injection, early hints, and asset manifests. A chunk resolves its dynamic imports itself, at run time, from its own content. Those names do not appear in importers. So the static closure is the set of names behind a stable name that can appear in an importer's bytes, and it is the set the importer's hash must cover.

### Stable name identity

A stable name is the chunk's preliminary file name with the hash slot filled by an identity hash of the same width: `common-!~{003}~.js` becomes `common-5f5f2b1ff4d0.js`. Same width keeps sourcemaps correct, because substitution happens after sourcemap generation.

The identity is a hash of `(is_path, id)`. For an entry chunk, `id` is the facade module id, made relative to `cwd` when it is a filesystem path. For a named common chunk, `id` is the chunk name. A later common chunk with the same name uses the smallest key among its original members. This is the scheme of [rolldown/rolldown#11277](https://github.com/rolldown/rolldown/pull/11277), the fix for [#11279](https://github.com/rolldown/rolldown/issues/11279). If #11277 merges first, this part of the change is removed.

## Vite change

`vite:css-post` adds an import-map entry for each chunk's CSS when `build.chunkImportMap` is on. When the chunk has no stable name, it falls back to the chunk's real file name. With a subset mapped, the fallback makes an entry for each chunk with CSS and writes stable-name-shaped CSS names into preload lists. The fix skips chunks without a stable name:

```diff
 for (const [chunkFileName, referenceId] of chunkCssReferences) {
   const chunk = chunksByPreliminaryFileName.get(chunkFileName)
   if (!chunk) continue
-  const stableChunkFileName = importMapReverseMapping[chunk.fileName] ?? chunk.fileName
+  const stableChunkFileName = importMapReverseMapping[chunk.fileName]
+  if (stableChunkFileName === undefined) continue
   const extension = path.posix.extname(stableChunkFileName)
```

For mapped chunks, the stable CSS name is correct. CSS assets are not placeholders, so the hashing rule does not cover them. The stable CSS name ties the CSS to the chunk identity and the import map resolves it. When all chunks are mapped, the change has no effect.

## Results

### Reduced test case

The repository builds one application in two configurations: our userland setup (`current/`) and the proposal (`proposed/`). Eight modules, three mapped, Vite 8.3.4, minified, hidden sourcemaps. Each row changes one module between two builds and compares the `page` chunk, the importer whose preload lists change. Both configurations give the same result in each row:

| change                                                                | result                                |
| --------------------------------------------------------------------- | ------------------------------------- |
| `common` stops importing `vendor`                                     | new name; 5 files renamed             |
| `vendor` changes                                                      | new name; 5 files renamed             |
| `settings` changes (behind the dynamically imported, mapped `slice`) | new name; 4 files renamed             |
| `common` body changes, same imports                                   | same name, same bytes; 1 file renamed |
| `slice` body changes, same imports                                    | same name, same bytes; 1 file renamed |
| `util` changes (behind the hashed `editor`)                           | new name; 4 files renamed             |

The first three rows are changes behind a mapped chunk: `page` gets a new name because its preload lists change. The next two rows are changes inside a mapped chunk: `page` keeps its name, and only the mapped chunk's file and the import map change. Two builds of the same input are byte-for-byte identical in both configurations.

The difference is in what each configuration needs. The userland configuration needs unhashed names, the rename plugin, the preload filter, the two `augmentChunkHash` plugins, and `comments: {legal: true}`. The proposal needs `include` and the Vite change. Both need `minifyInternalExports: false` and a server that inlines the import map.

### Production application

We built our application with the proposal and with our plugins removed, and compared the output with the output of our userland configuration. The chunk graph is the same: each chunk has the same module set. After normalization of the names the proposal changes (hashes in file names and references, the stable-name form of the shared chunks, and the stable-name entries in preload lists), all chunks are byte-identical. Stable names are identical across builds. Build time is unchanged with a release build of Rolldown.

Served from a production-mode server with the import map inlined: each script and stylesheet loads. No request uses a stable name; the browser fetches content-hashed files only. Mapped chunks named in preload lists load once each as `modulepreload` before the dynamic import that needs them. There are no preload, integrity, or CSP errors.

## Implementation

One commit on `v1.2.14`, about 230 lines without test fixtures:

| file                                                                | change                                                                                                                                                               |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crates/rolldown_common/.../chunk_import_map.rs`                    | `include: Option<Arc<dyn Fn(&RollupPreRenderedChunk) -> Future<bool>>>`; a shared `stable_names` table written during hashing, read when emitting                         |
| `crates/rolldown/src/utils/chunk/chunk_import_map_stable_names.rs` (new) | stable name computation; same-width substitution; `static_dependencies_of_mapped` (from `cross_chunk_imports`); `collapse_mapped_dependencies`                           |
| `crates/rolldown/src/utils/chunk/finalize_chunks.rs`                | read the dependency graph from the original placeholders, substitute stable names, compute standalone hashes, collapse edges through mapped chunks, compute final hashes |
| `crates/rolldown_plugin_chunk_import_map/src/lib.rs`                | no `renderChunk` rewrite; emits `importmap.json` from the recorded stable names                                                                                           |
| `crates/rolldown_binding/...`                                       | `include` as a napi `JsCallback`, the same pattern as `chunkFileNames`                                                                                               |
| `packages/rolldown/src/...`                                         | TypeScript type, validator, bindingify                                                                                                                               |

A rebase onto current `main` conflicts in the plugin file only. Upstream reworked that file for inline common chunks in [#11230](https://github.com/rolldown/rolldown/pull/11230); the equivalent logic now lives in `finalize_assets`.

### Tests

`crates/rolldown/tests/rolldown/function/chunk_import_map_include/` builds variants of a six-module graph and compares pairs of outputs:

- the import map lists the included chunks only, stable name to content-hashed name;
- importers reference mapped chunks by stable name only, with no placeholder left;
- a change behind a mapped chunk renames the importer and keeps the stable names;
- a change to a mapped chunk's own body renames that file and its import map entry only;
- a change behind a dynamically imported mapped chunk renames the importer;
- a change to a mapped chunk's dynamic import target renames nothing else;
- stable names are identical across builds.

The existing integration suite passes. `cargo fmt` and `cargo clippy` are clean under the repository's lints.

## What we can remove

With the proposal, our build no longer needs:

- unhashed `chunkFileNames` for the shared chunks;
- post-build hashing and renaming of those chunks, and hand-built import-map construction (`importmap.json` replaces it);
- the two `augmentChunkHash` plugins, and `comments: {legal: true}`;
- the `modulePreload.resolveDependencies` filter. Vite writes the stable name into `__vite__mapDeps` and resolves it with `import.meta.resolve` before it creates the link, so the link has the content-hashed URL. A build-time URL would make the importer's bytes depend on the mapped chunk's content again.

We still inline the import map and integrity hashes into the document.

## Open items

- **Export names.** We set `minifyInternalExports: false` for all chunks, because the exports of a mapped chunk must keep their names when its content changes. Rolldown could keep stable export names for mapped chunks only.
- **Stable name template.** The stable name keeps the `[name]-<hash>` form for the sourcemap reason above. A `[name].js` form would need padding or sourcemap remapping.
- **Escape hatch.** An option for mapped chunks to add no dependencies at all, for a build that runs no post-hash tooling.
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

## Alternative: write preload lists before hashing

<details>
<summary>The hashing rule compensates for a post-hash write. The write itself could move.</summary>

The hash gap exists because Vite writes `__vite__mapDeps` in `generateBundle`, after hashing, with final file names. The content of the list is not the problem. The timing is.

### The alternative

During `renderChunk`, each chunk has a preliminary file name with a hash placeholder, and `meta.chunks[x].imports` lists other chunks by those placeholder names. If Vite wrote `__vite__mapDeps` in `renderChunk` with placeholder names, the bundler would do the rest:

- It resolves the placeholders to final names after hashing. This is how `import './dep.js'` statements work today.
- Each placeholder in the code is an edge in the hash graph. `page` would depend on `vendor` because the placeholder of `vendor` is in its bytes.

The gap then closes for all builds, not only for builds with an import map. A chunk with a hand-given unhashed name has the same gap today.

### Effect on this proposal

The stock chunk import map plugin runs in `renderChunk`, pinned last, and replaces the placeholders of all chunks in its table with stable hashes. With `include`, the table holds the included chunks only. The existing filter in the plugin then does the rest:

- placeholders of mapped chunks become stable hashes, so they add no edges, as today;
- placeholders of unmapped chunks stay, so they add edges and resolve to final hashes, as today;
- the import map lists the included chunks only, because the table holds nothing else.

Placeholders that Vite writes into `__vite__mapDeps` before the plugin runs go through the same filter. The Rolldown change becomes the `include` option and a filter when the plugin builds its table. The hashing rule, the collapse of edges through mapped chunks, and the move of substitution into `finalize_assets` are not needed. The `vite:css-post` change and the stable name identity of #11277 are needed in both designs.

### The obstacle

`renderChunk` runs for all chunks concurrently. The JavaScript half of a preload list is available from the start, through `meta.chunks`. The CSS half (`viteMetadata.importedCss`) is produced by `vite:css-post` in its own `renderChunk` for the other chunk, which may not have run yet. Three ways to get the CSS half:

1. Wait inside `renderChunk` for the metadata of the chunks in the list. Our manifest plugin does this today for its CSS augmentation. It works, and it is not simple.
2. A Rolldown hook that runs once after all `renderChunk` calls and before hashing, with the code of all chunks available. This hook does not exist today.
3. Rolldown writes the preload lists itself, as a builtin plugin. Rolldown has the chunk graph before it renders, so it can write placeholder lists without a wait. Rolldown already has builtin versions of several Vite plugins.

### Other approaches, considered and rejected

- **`hoistTransitiveImports`.** Rollup makes an entry chunk, including a dynamic import target, statically import its transitive closure, so the browser fetches the closure in parallel after it has the target. The imports are written before hashing, so the hash graph covers them. This is why the gap is rare on Rollup, but it is not a fix: the hoisted imports are inside the target, so when the target is a mapped chunk its importer's hash still does not cover them (the third row of the test case collides on Rollup too), and CSS names are not imports. It also costs one more network hop than a preload list. Rolldown declares the option and does not implement it.
- **A dependency manifest outside the chunks.** Emit `chunk → static closure` as an asset, inline it next to the import map, and look it up at run time in the preload helper. No chunk then contains anything about its transitive closure. The manifest grows with the number of edges in the graph, changes on every build, and each dynamic import does a lookup. For our build it is larger than the all-in import map, which we already cannot inline. The preload lists in the chunks are the same data, split so that each chunk carries only its own part and caches with it.

</details>
