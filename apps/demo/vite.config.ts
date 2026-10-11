import { defineConfig, type Plugin } from 'vite';

/**
 * Cross-origin isolation (COOP/COEP) so the multi-threaded wasm build can run.
 * Open the page with ?noIsolation to exercise the single-threaded fallback.
 */
function isolation(): Plugin {
  const apply = (req: { url?: string; headers: Record<string, string | string[] | undefined> }, res: { setHeader(k: string, v: string): void }) => {
    const isDocument = String(req.headers.accept ?? '').includes('text/html');
    const optOut = (req.url ?? '').includes('noIsolation');
    if (!(isDocument && optOut)) {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    }
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  };
  return {
    name: 'pup-isolation',
    configureServer(server) {
      server.middlewares.use((req, res, next) => (apply(req, res), next()));
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => (apply(req, res), next()));
    },
  };
}

export default defineConfig({
  plugins: [isolation()],
  server: { fs: { allow: ['../..'] } },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@krab3000/pup-wasm', '@krab3000/pup-player'] },
  build: { target: 'es2022' },
});
