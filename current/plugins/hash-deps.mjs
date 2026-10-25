// The JavaScript half of the hash gap (see the write-up), closed in userland.
//
// Rolldown renders `!~{<id>}~` where a chunk's hash will go, and a chunk's final
// hash covers each chunk whose placeholder appears in its rendered code. The
// mapped chunks have no placeholder, so the hashed chunks behind them are not
// covered in their importers. Vite's __vite__mapDeps names those chunks and is
// written after hashing.
//
// For each hashed chunk, this appends a legal comment that names, for each
// mapped chunk it imports, the hashed chunks reached from there through
// mapped chunks only. Legal comments survive minification, so the bundler
// sees the placeholders when it hashes. The comment is removed in
// generateBundle, when hashes are final.
//
// This depends on two bundler internals: the placeholder format, and legal
// comments staying in place through minification.
const PLACEHOLDER = /!~\{[\w$]+\}~/;
const MARKER_START = '/*! hash-deps:';
const MARKER_END = ' */';

const isHashed = (fileName) => PLACEHOLDER.test(fileName);

function hashedFrontier(fileName, chunks) {
  const frontier = [];
  const visited = new Set();
  function walk(current) {
    if (visited.has(current)) return;
    visited.add(current);
    for (const imported of chunks[current]?.imports ?? []) {
      if (!isHashed(imported)) walk(imported);
      else if (!frontier.includes(imported)) frontier.push(imported);
    }
  }
  walk(fileName);
  return frontier;
}

export function hashDepsPlugin() {
  let injected = 0;
  return {
    name: 'hash-deps',
    apply: 'build',
    enforce: 'post',

    renderChunk(code, chunk, _options, meta) {
      if (!isHashed(chunk.fileName)) return null;
      const groups = [];
      for (const imported of new Set([
        ...chunk.imports,
        ...chunk.dynamicImports,
      ])) {
        if (isHashed(imported)) continue;
        const frontier = hashedFrontier(imported, meta.chunks).filter(
          (f) => f !== chunk.fileName,
        );
        if (frontier.length > 0)
          groups.push(`${imported}>${frontier.join(',')}`);
      }
      if (groups.length === 0) return null;
      injected++;
      return {
        code: `${code}\n${MARKER_START}${groups.join(';')}${MARKER_END}`,
        map: null,
      };
    },

    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        let removed = 0;
        for (const chunk of Object.values(bundle)) {
          if (chunk.type !== 'chunk') continue;
          const start = chunk.code.lastIndexOf(MARKER_START);
          if (start === -1) continue;
          const end = chunk.code.indexOf(MARKER_END, start) + MARKER_END.length;
          chunk.code =
            chunk.code.slice(
              0,
              chunk.code[start - 1] === '\n' ? start - 1 : start,
            ) + chunk.code.slice(end);
          removed++;
        }
        if (removed !== injected) {
          this.error(
            `hash-deps: ${injected} markers injected, ${removed} found. A hash was computed without its marker.`,
          );
        }
      },
    },
  };
}
