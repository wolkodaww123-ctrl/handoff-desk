// Bundles the two web clients with esbuild and embeds all static files into src/assets.js,
// so the whole app deploys as one Cloudflare Worker.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });
for (const name of ['visitor', 'desk']) {
  await build({ entryPoints: [`web/${name}.js`], bundle: true, minify: true, format: 'esm', target: 'es2020', outfile: `dist/${name}.js`, legalComments: 'none', platform: 'browser', external: ['path', 'fs', 'os', 'crypto', 'url', 'http', 'https', 'net', 'tls', 'ws'] });
}
const files = {
  '/index.html': ['web/index.html', 'text/html; charset=utf-8'],
  '/desk.html': ['web/desk.html', 'text/html; charset=utf-8'],
  '/style.css': ['web/style.css', 'text/css; charset=utf-8'],
  '/visitor.js': ['dist/visitor.js', 'text/javascript; charset=utf-8'],
  '/desk.js': ['dist/desk.js', 'text/javascript; charset=utf-8'],
};
const out = {};
for (const [k, [f, type]] of Object.entries(files)) out[k] = { type, body: readFileSync(f, 'utf8') };
writeFileSync('src/assets.js', 'export const ASSETS = ' + JSON.stringify(out) + ';\n');
console.log('built', Object.keys(out).map((k) => `${k} ${out[k].body.length}B`).join(', '));
