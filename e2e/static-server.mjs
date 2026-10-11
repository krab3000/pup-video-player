// Minimal static server for the standalone-bundle e2e: serves the built bundle as-is (no
// bundler, no transforms) the way a user would host it.
//   /pup/*   -> packages/pup-player-bundle/dist
//   /media/* -> test-media
//   /*       -> e2e/bundle-site
// /isolated.html is served with COOP (cross-origin isolated), which makes the player use the
// multi-threaded core; every other page is not isolated. Every response carries COEP and CORP:
// an isolated page only accepts worker scripts that are themselves served with COEP, and COEP on
// a page without COOP does not isolate it.
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.argv[2] ?? 5198);
const mounts = [
  ['/pup/', join(root, 'packages/pup-player-bundle/dist')],
  ['/media/', join(root, 'test-media')],
  ['/', join(root, 'e2e/bundle-site')],
];
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  const [prefix, dir] = mounts.find(([p]) => path.startsWith(p));
  const file = normalize(join(dir, path.slice(prefix.length) || 'index.html'));
  let size;
  try {
    if (!file.startsWith(dir)) throw new Error('outside mount');
    size = statSync(file).size;
  } catch {
    res.writeHead(404).end();
    return;
  }
  const headers = {
    'Content-Type': types[extname(file)] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  };
  if (path === '/isolated.html') headers['Cross-Origin-Opener-Policy'] = 'same-origin';
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`bundle site on http://localhost:${port}`));
