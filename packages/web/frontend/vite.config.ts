import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The build lands *inside the Python package* (`src/gemdex_web/static`) rather
 * than a local `dist/`, because the BFF serves it from one origin in
 * production. Same origin means no CORS configuration and a same-site session
 * cookie by construction — see `packages/web/AGENTS.md`.
 */
export default defineConfig({
    plugins: [react()],
    build: {
        outDir: '../src/gemdex_web/static',
        emptyOutDir: true,
        // Source maps would ship this app's logic to anyone who opens devtools.
        // It is a single-user admin UI, so the debugging value does not justify
        // publishing it.
        sourcemap: false,
    },
    server: {
        host: '127.0.0.1',
        port: 5173,
        // In development the SPA runs on Vite's port and the BFF on 8767. These
        // proxies keep every request same-origin from the browser's point of
        // view, so the session cookie behaves exactly as it will in production
        // — without this, dev would need CORS plus SameSite=None and would stop
        // resembling the deployed setup.
        proxy: {
            '/api': { target: 'http://127.0.0.1:8767', changeOrigin: false },
            '/auth': { target: 'http://127.0.0.1:8767', changeOrigin: false },
            '/healthz': { target: 'http://127.0.0.1:8767', changeOrigin: false },
        },
    },
});
