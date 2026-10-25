// Serves a built variant with the import map inlined into the HTML document,
// as a production server does. Logs each request, so that you can see which
// files the browser fetches.
//
//   node scripts/serve.mjs current
//   node scripts/serve.mjs proposed
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const variant = process.argv[2];
if (!['current', 'proposed'].includes(variant)) {
  console.error('usage: node scripts/serve.mjs <current|proposed>');
  process.exit(1);
}
const dist = path.join(root, variant, 'dist');
const port = Number(process.env.PORT ?? 5173);

const integrityOf = (file) =>
  `sha256-${crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(dist, file)))
    .digest('base64')}`;

function importMapAndEntry() {
  if (variant === 'current') {
    // The plugin wrote the import map, integrity hashes, and the renamed entry.
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'),
    );
    return {importMap: manifest.importMap, entry: manifest.entry};
  }
  // Rolldown wrote the import map. Integrity comes from the files on disk.
  const {imports} = JSON.parse(
    fs.readFileSync(path.join(dist, 'importmap.json'), 'utf8'),
  );
  const integrity = Object.fromEntries(
    Object.values(imports).map((url) => [url, integrityOf(url.slice(1))]),
  );
  const viteManifest = JSON.parse(
    fs.readFileSync(path.join(dist, '.vite/manifest.json'), 'utf8'),
  );
  return {
    importMap: {imports, integrity},
    entry: `/${viteManifest['main.js'].file}`,
  };
}

function html() {
  const {importMap, entry} = importMapAndEntry();
  return fs
    .readFileSync(path.join(root, 'app/index.html'), 'utf8')
    .replace(
      '<!--IMPORTMAP-->',
      `<script type="importmap">\n${JSON.stringify(importMap, null, 2)}\n    </script>`,
    )
    .replace('<!--ENTRY-->', `<script type="module" src="${entry}"></script>`);
}

const TYPES = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.map': 'application/json',
  '.json': 'application/json',
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    let status;
    if (url.pathname === '/') {
      status = 200;
      res.writeHead(200, {
        'content-type': 'text/html',
        'cache-control': 'no-store',
      });
      res.end(html());
    } else {
      const file = path.join(dist, path.normalize(url.pathname));
      if (
        file.startsWith(dist) &&
        fs.existsSync(file) &&
        fs.statSync(file).isFile()
      ) {
        status = 200;
        res.writeHead(200, {
          'content-type':
            TYPES[path.extname(file)] ?? 'application/octet-stream',
          'cache-control': 'public, max-age=31536000, immutable',
        });
        res.end(fs.readFileSync(file));
      } else {
        status = 404;
        res.writeHead(404).end('not found');
      }
    }
    console.log(`${status} ${url.pathname}`);
  })
  .listen(port, () => console.log(`${variant}: http://localhost:${port}/`));
