// Copies the repository LICENSE (LGPL-2.1) into the package being built, so every published
// tarball carries the license text. Run from a package directory.
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

copyFileSync(fileURLToPath(new URL('../LICENSE', import.meta.url)), 'LICENSE');
