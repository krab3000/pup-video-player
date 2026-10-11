import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Built as an app with a script entry rather than in library mode: library mode inlines workers as
// blob URLs, which breaks the wasm URLs the workers resolve relative to their own location. Here
// the workers, FFmpeg cores and wasm are emitted next to pup-player.js and loaded relative to it,
// so the dist folder can be served from anywhere.
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(import.meta.dirname, 'src/index.ts'),
      preserveEntrySignatures: 'strict',
      output: {
        entryFileNames: 'pup-player.js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
