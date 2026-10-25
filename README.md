# Partial chunk import maps with Vite and Rolldown

A reduced test case for aliasing a subset of chunks through an import map.

- `current/` shows how we do it today, with plugins, on stock Vite 8 and stock Rolldown. It has a hash gap: a build can change the bytes of a chunk without changing its file name.
- `proposed/` shows the same build with `experimental.chunkImportMap.include` in Rolldown and a two-line change in Vite. The plugins are gone and the hash gap is closed.

The proposal is described in [partial-chunk-import-maps.md](./partial-chunk-import-maps.md).

## The application

Eight modules in `app/`, one chunk each:

```
main (entry, aliased)
└── page
    ├── common (aliased) ── vendor
    ├── import('./editor') ── common, util
    └── import('./slice') (aliased) ── settings
```

`common`, `editor`, and `slice` import a CSS file each. `main`, `common`, and `slice` get a stable name in the import map. `shared/chunks.mjs` holds this list and the chunk layout, so that both configurations build the same chunk graph.

The `page` chunk is the one to watch. Its preload lists for `import('./editor')` and `import('./slice')` contain the file names of `vendor` and `settings`, which are reached through aliased chunks only.

## Run the comparison

```sh
# current: stock Vite 8.3.4 (stock Rolldown)
(cd current && pnpm install)

# proposed: Vite 8.3.4 with patches/vite@8.3.4.patch, Rolldown from the branch
./scripts/setup-rolldown.sh      # clones and builds the branch into vendor/ (Rust toolchain needed)
(cd proposed && pnpm install)

node scripts/matrix.mjs           # or: node scripts/matrix.mjs current
```

`matrix.mjs` builds the application twice per scenario, with one file changed between the two builds, and compares the outputs. It also builds the same input twice and checks that the output is identical.

| change                                                                | current                        | current + FIX=1       | proposed              |
| --------------------------------------------------------------------- | ------------------------------ | --------------------- | --------------------- |
| `common` stops importing `vendor`                                     | **same name, different bytes** | new name              | new name              |
| `vendor` changes                                                      | **same name, different bytes** | new name              | new name              |
| `settings` changes (behind the dynamically imported, aliased `slice`) | **same name, different bytes** | new name              | new name              |
| `common` body changes, same imports                                   | same name, same bytes          | same name, same bytes | same name, same bytes |
| `slice` body changes, same imports                                    | same name, same bytes          | same name, same bytes | same name, same bytes |
| `util` changes (behind the hashed `editor`)                           | new name                       | new name              | new name              |

Each cell is the result for the `page` chunk. "Same name, different bytes" means an immutable CDN continues to serve the old file.

`current + FIX=1` adds `current/plugins/hash-deps.mjs`, which closes the gap by hand. It is here to show what the fix costs in plugin code when the bundler does not have the rule.

## Run it in a browser

```sh
(cd current && pnpm build) && node scripts/serve.mjs current
(cd proposed && pnpm build) && node scripts/serve.mjs proposed
```

The server inlines the import map and integrity hashes into `index.html` and logs each request. Open http://localhost:5173/, click the two buttons, and look at the network panel: the browser requests content-hashed files only. In `proposed`, the preload helper resolves the aliases in `__vite__mapDeps` through the import map before it creates the `<link rel="modulepreload">` tags.

## What is in each configuration

### `current/`

| file                              | what it does                                                                                                                                                                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vite.config.mjs`                 | Aliased chunks get file names without a hash. `modulePreload.resolveDependencies` removes them from preload lists. `minifyInternalExports: false` keeps their export names stable.                                                           |
| `plugins/import-map-manifest.mjs` | `renderChunk` + `augmentChunkHash`: adds the CSS behind the aliased chunks to importers' hashes, with a wait for each chunk's import tree. `writeBundle`: hashes and renames the aliased chunks, writes the import map and integrity hashes. |
| `plugins/hash-deps.mjs` (`FIX=1`) | Adds the JavaScript behind the aliased chunks to importers' hashes, through a legal comment with hash placeholders that is removed after hashing.                                                                                            |

### `proposed/`

| file                       | what it does                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `vite.config.mjs`          | `chunkImportMap: true` and `experimental.chunkImportMap.include`. All chunks have hashed names. No plugins. |
| `patches/vite@8.3.4.patch` | `vite:css-post` aliases the CSS of aliased chunks only.                                                     |
| `pnpm-workspace.yaml`      | Points `rolldown` at `vendor/rolldown/packages/rolldown`.                                                   |

Rolldown branch: https://github.com/iAmNathanJ/rolldown/tree/feat/chunk-import-map-include (one commit on `v1.2.14`).
