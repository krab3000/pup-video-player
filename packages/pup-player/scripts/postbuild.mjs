// tsc does not rewrite string literals, so the worker URLs in the compiled engine still name the
// .ts sources. Point them at the emitted .js files.
import { readFileSync, writeFileSync } from 'node:fs';

const file = 'lib/engine/engine.js';
const source = readFileSync(file, 'utf8');
const rewritten = source.replace(/new URL\('\.\/(\w+)\.worker\.ts'/g, "new URL('./$1.worker.js'");
if (!/new URL\('\.\/demux\.worker\.js'/.test(rewritten) || !/new URL\('\.\/decode\.worker\.js'/.test(rewritten)) {
  throw new Error(`${file}: worker URLs not found; update scripts/postbuild.mjs`);
}
writeFileSync(file, rewritten);
