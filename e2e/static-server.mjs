// Minimal static server for the standalone-bundle and HLS e2e: serves the built bundle as-is (no
// bundler, no transforms) the way a user would host it.
//   /pup/*   -> packages/pup-player-bundle/dist
//   /media/* -> test-media
//   /*       -> e2e/bundle-site
// /isolated.html is served with COOP (cross-origin isolated), which makes the player use the
// multi-threaded core; every other page is not isolated. Every response carries COEP and CORP:
// an isolated page only accepts worker scripts that are themselves served with COEP, and COEP on
// a page without COOP does not isolate it.
//
// Generated HLS playlists for e2e/hls.spec.ts (segments from test-media/hls/vod-ts, 5 x 2 s),
// served with CORS so the demo app (another port) can fetch them. <id> isolates each test's
// state; the clock starts at its first playlist request.
//   /hls-growing/<id>/index.m3u8  Cove-style EVENT playlist: root-relative segment URIs with query
//                                 strings, one more segment per second, a discontinuity with a
//                                 timestamp reset (segments 0-2, then 0-1 again), ENDLIST at the end
//   /hls-live/<id>/index.m3u8     live sliding window of 4 segments, one new segment every 2 s
//   /hls-late/<id>/index.m3u8     VOD whose segment 1 answers 404 (after 1.5 s) twice
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
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};

const SEGMENT = 2;
const hlsState = new Map();
const cors = { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Cache-Control': 'no-store' };
const extinf = (uri) => `#EXTINF:${SEGMENT.toFixed(6)},\n${uri}\n`;

function hlsPlaylist(kind, id, elapsed) {
  const head = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${SEGMENT}\n`;
  if (kind === 'growing') {
    const count = Math.min(5, 2 + Math.floor(elapsed));
    let body = `${head}#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:EVENT\n`;
    for (let i = 0; i < count; i++) {
      if (i === 3) body += '#EXT-X-DISCONTINUITY\n';
      body += extinf(`/hls-growing/${id}/seg/${i % 3}.ts?session=${id}&part=${i < 3 ? 1 : 2}`);
    }
    return count === 5 ? `${body}#EXT-X-ENDLIST\n` : body;
  }
  if (kind === 'live') {
    // Segment s plays vod-ts segment s % 5; time restarts at each wrap, hence the discontinuities.
    const first = Math.floor(elapsed / SEGMENT);
    let body = `${head}#EXT-X-MEDIA-SEQUENCE:${first}\n#EXT-X-DISCONTINUITY-SEQUENCE:${Math.floor(first / 5)}\n`;
    for (let s = first; s < first + 4; s++) {
      if (s > first && s % 5 === 0) body += '#EXT-X-DISCONTINUITY\n';
      body += extinf(`/hls-live/${id}/seg/${s % 5}.ts`);
    }
    return body;
  }
  let body = `${head}#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n`;
  for (let i = 0; i < 5; i++) body += extinf(`/hls-late/${id}/seg/${i}.ts`);
  return `${body}#EXT-X-ENDLIST\n`;
}

/** Handles the generated HLS routes; false for any other path. */
function serveHls(path, res) {
  const m = /^\/hls-(growing|live|late)\/([\w-]+)\/(index\.m3u8|seg\/(\d+)\.ts)$/.exec(path);
  if (!m) return false;
  const [, kind, id, , seg] = m;
  const key = `${kind}/${id}`;
  if (!hlsState.has(key)) hlsState.set(key, { start: Date.now(), misses: 0 });
  const state = hlsState.get(key);
  if (seg === undefined) {
    const body = hlsPlaylist(kind, id, (Date.now() - state.start) / 1000);
    res.writeHead(200, { ...cors, 'Content-Type': types['.m3u8'] }).end(body);
    return true;
  }
  if (kind === 'late' && seg === '1' && state.misses < 2) {
    state.misses++;
    setTimeout(() => res.writeHead(404, cors).end(), 1500);
    return true;
  }
  const file = join(root, `test-media/hls/vod-ts/seg${seg}.ts`);
  let size;
  try {
    size = statSync(file).size;
  } catch {
    res.writeHead(404, cors).end();
    return true;
  }
  res.writeHead(200, { ...cors, 'Content-Type': types['.ts'], 'Content-Length': size });
  createReadStream(file).pipe(res);
  return true;
}

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  if (serveHls(path, res)) return;
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
