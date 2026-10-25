// Builds the application twice per scenario (before and after one change) and
// compares the two outputs.
//
//   node scripts/matrix.mjs                 # both variants, if installed
//   node scripts/matrix.mjs current
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const tmp = path.join(root, '.tmp');

const VARIANTS = {
  current: {dir: 'current'},
  proposed: {dir: 'proposed'},
};

// Each scenario replaces one file of app/ between the two builds.
const SCENARIOS = [
  {
    label: '`common` stops importing `vendor`',
    files: {
      'common.js': `import './common.css';\n\nexport function format(text) {\n  return \`[APP] \${text}\`;\n}\n`,
    },
    expect: 'new name',
  },
  {
    label: '`vendor` changes',
    files: {
      'vendor.js': `export function upper(text) {\n  return \`\${text.toUpperCase()}!\`;\n}\n`,
    },
    expect: 'new name',
  },
  {
    label:
      '`settings` changes (behind the dynamically imported, mapped `slice`)',
    files: {
      'settings.js': `export const defaults = {theme: 'dark', density: 'comfortable'};\n`,
    },
    expect: 'new name',
  },
  {
    label: '`common` body changes, same imports',
    files: {
      'common.js': `import './common.css';\nimport {upper} from './vendor.js';\n\nexport function format(text) {\n  return \`[\${upper('app')}] \${text}.\`;\n}\n`,
    },
    expect: 'same name, same bytes',
  },
  {
    label: '`slice` body changes, same imports',
    files: {
      'slice.js': `import './slice.css';\nimport {defaults} from './settings.js';\n\nexport function settings() {\n  return \`settings => \${JSON.stringify(defaults)}\`;\n}\n`,
    },
    expect: 'same name, same bytes',
  },
  {
    label: '`util` changes (behind the hashed `editor`)',
    files: {
      'util.js': `export function clamp(n, lo, hi) {\n  return Math.min(hi, Math.max(lo, n)) | 0;\n}\n`,
    },
    expect: 'new name',
  },
];

function build(variant, files, outName) {
  const {dir} = VARIANTS[variant];
  const appDir = path.join(tmp, `app-${variant}`);
  fs.rmSync(appDir, {recursive: true, force: true});
  fs.cpSync(path.join(root, 'app'), appDir, {recursive: true});
  for (const [name, code] of Object.entries(files))
    fs.writeFileSync(path.join(appDir, name), code);

  const outDir = path.join(tmp, `out-${variant}-${outName}`);
  fs.rmSync(outDir, {recursive: true, force: true});
  execFileSync(
    'node',
    ['node_modules/vite/bin/vite.js', 'build', '-c', 'vite.config.mjs'],
    {
      cwd: path.join(root, dir),
      env: {...process.env, APP_DIR: appDir, OUT_DIR: outDir},
      stdio: ['ignore', 'ignore', 'inherit'],
    },
  );

  const output = new Map();
  for (const file of fs.readdirSync(outDir, {recursive: true})) {
    if (!/\.(js|css)$/.test(file)) continue;
    output.set(file, fs.readFileSync(path.join(outDir, file)));
  }
  return output;
}

function compare(before, after) {
  let renamed = 0;
  const collisions = [];
  for (const [name, bytes] of before) {
    if (!after.has(name)) renamed++;
    else if (!bytes.equals(after.get(name))) collisions.push(name);
  }
  const pageBefore = [...before.keys()].find((f) => /^page-.*\.js$/.test(f));
  const pageAfter = [...after.keys()].find((f) => /^page-.*\.js$/.test(f));
  const page =
    pageBefore !== pageAfter
      ? 'new name'
      : before.get(pageBefore).equals(after.get(pageAfter))
        ? 'same name, same bytes'
        : 'same name, different bytes';
  return {renamed, collisions, page};
}

const requested = process.argv.slice(2);
const variants = (requested.length ? requested : Object.keys(VARIANTS)).filter(
  (variant) => {
    if (!VARIANTS[variant]) throw new Error(`unknown variant ${variant}`);
    const installed = fs.existsSync(
      path.join(root, VARIANTS[variant].dir, 'node_modules/vite'),
    );
    if (!installed)
      console.error(
        `skip ${variant}: run pnpm install in ${VARIANTS[variant].dir}/ first`,
      );
    return installed;
  },
);

const results = {};
let failures = 0;
for (const variant of variants) {
  const base = build(variant, {}, 'base');
  const again = build(variant, {}, 'again');
  const determinism = compare(base, again);
  if (determinism.renamed || determinism.collisions.length) {
    console.error(`${variant}: two builds of the same input differ`);
    failures++;
  }
  results[variant] = SCENARIOS.map((scenario) => {
    const result = compare(base, build(variant, scenario.files, 'changed'));
    const ok = result.page === scenario.expect && result.collisions.length === 0;
    if (!ok) failures++;
    return {...result, ok};
  });
}

const header = [
  'change',
  ...variants.map((v) => (v === 'current-fixed' ? 'current + FIX=1' : v)),
];
const rows = SCENARIOS.map((scenario, i) => [
  scenario.label,
  ...variants.map((variant) => {
    const {page, renamed, collisions, ok} = results[variant][i];
    let cell = `${page}; ${renamed} file${renamed === 1 ? '' : 's'} renamed`;
    if (collisions.length) cell = `**${cell}; ${collisions.length} same name, different bytes**`;
    return ok ? cell : `${cell} ✗ expected: ${scenario.expect}`;
  }),
]);
console.log(`| ${header.join(' | ')} |`);
console.log(`| ${header.map(() => '---').join(' | ')} |`);
for (const row of rows) console.log(`| ${row.join(' | ')} |`);
console.log(
  `\nEach cell gives the result for the \`page\` chunk, the importer whose preload lists change, ` +
    `and the number of files in the whole output that got a new name.`,
);
process.exit(failures ? 1 : 0);
