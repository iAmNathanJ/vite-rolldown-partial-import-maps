# Partial chunk import maps with Vite and Rolldown

A reduced test case for aliasing a subset of chunks through an import map. Two configurations build the same application:

- `current/`: how we do it today, in userland. Plugins on stock Vite 8 and stock Rolldown.
- `proposed/`: how it works when the bundler does it. `experimental.chunkImportMap.include` in Rolldown and a two-line change in Vite. No plugins.

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

The `page` chunk is the one to watch. Its preload lists for `import('./editor')` and `import('./slice')` contain the file names of `vendor` and `settings`, which it reaches through aliased chunks only.

## Run the comparison

```sh
# current: stock Vite 8.3.4 (stock Rolldown)
(cd current && pnpm install)

# proposed: Vite 8.3.4 with patches/vite@8.3.4.patch, Rolldown from the branch
./scripts/setup-rolldown.sh      # clones and builds the branch into vendor/ (Rust toolchain needed)
(cd proposed && pnpm install)

node scripts/matrix.mjs           # or: node scripts/matrix.mjs current
```

`matrix.mjs` builds the application twice per scenario, with one file changed between the two builds, and compares the outputs. It also builds the same input twice and checks that the output is identical. Both configurations give the same result in each scenario:

| change                                                                | current                               | proposed                              |
| --------------------------------------------------------------------- | ------------------------------------- | ------------------------------------- |
| `common` stops importing `vendor`                                     | new name; 5 files renamed             | new name; 5 files renamed             |
| `vendor` changes                                                      | new name; 5 files renamed             | new name; 5 files renamed             |
| `settings` changes (behind the dynamically imported, aliased `slice`) | new name; 4 files renamed             | new name; 4 files renamed             |
| `common` body changes, same imports                                   | same name, same bytes; 1 file renamed | same name, same bytes; 1 file renamed |
| `slice` body changes, same imports                                    | same name, same bytes; 1 file renamed | same name, same bytes; 1 file renamed |
| `util` changes (behind the hashed `editor`)                           | new name; 4 files renamed             | new name; 4 files renamed             |

Each cell gives the result for the `page` chunk and the number of files in the whole output that got a new name. The first three rows are changes behind an aliased chunk: `page` must get a new name, because its preload lists change. The next two rows are changes inside an aliased chunk: `page` must keep its name, and only the aliased chunk's file and the import map change.

## What each configuration needs

|                                                                                                                | current | proposed |
| -------------------------------------------------------------------------------------------------------------- | ------- | -------- |
| File names without a hash for the aliased chunks                                                               | yes     | —        |
| Plugin: hash and rename the aliased chunks after the build; write the import map                               | yes     | —        |
| `modulePreload.resolveDependencies` filter for the unhashed names                                              | yes     | —        |
| Plugin: `augmentChunkHash` for the CSS behind the aliased chunks (waits for concurrent `renderChunk` calls)    | yes     | —        |
| Plugin: `augmentChunkHash` for the JavaScript behind the aliased chunks (hash placeholders in a legal comment) | yes     | —        |
| Depends on bundler internals: placeholder format, legal comments through minification                          | yes     | —        |
| `minifyInternalExports: false`                                                                                 | yes     | yes      |
| Inline the import map and integrity hashes into the document                                                   | yes     | yes      |
| Rolldown change                                                                                                | —       | yes      |
| Vite change (two lines)                                                                                        | —       | yes      |

## Run it in a browser

```sh
(cd current && pnpm build) && node scripts/serve.mjs current
(cd proposed && pnpm build) && node scripts/serve.mjs proposed
```

The server inlines the import map and integrity hashes into `index.html` and logs each request. Open http://localhost:5173/, click the two buttons, and look at the network panel: the browser requests content-hashed files only. In `proposed`, the preload helper resolves the aliases in `__vite__mapDeps` through the import map before it creates the `<link>` tags.

## Files

### `current/`

| file                              | what it does                                                                                                                                                                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vite.config.mjs`                 | Aliased chunks get file names without a hash. `modulePreload.resolveDependencies` removes them from preload lists. `minifyInternalExports: false` keeps their export names stable. `comments: {legal: true}` for `hash-deps.mjs`.            |
| `plugins/import-map-manifest.mjs` | `renderChunk` + `augmentChunkHash`: adds the CSS behind the aliased chunks to importers' hashes, with a wait for each chunk's import tree. `writeBundle`: hashes and renames the aliased chunks, writes the import map and integrity hashes. |
| `plugins/hash-deps.mjs`           | Adds the JavaScript behind the aliased chunks to importers' hashes, through a legal comment with hash placeholders that is removed after hashing.                                                                                            |

### `proposed/`

| file                       | what it does                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `vite.config.mjs`          | `chunkImportMap: true` and `experimental.chunkImportMap.include`. All chunks have hashed names. No plugins. |
| `patches/vite@8.3.4.patch` | `vite:css-post` aliases the CSS of aliased chunks only.                                                     |
| `pnpm-workspace.yaml`      | Points `rolldown` at `vendor/rolldown/packages/rolldown`.                                                   |

Rolldown branch: https://github.com/iAmNathanJ/rolldown/tree/feat/chunk-import-map-include (one commit on `v1.2.14`). Stock Vite 8.3.4 resolves Rolldown `1.2.15`; `current/` does not use `chunkImportMap`.
