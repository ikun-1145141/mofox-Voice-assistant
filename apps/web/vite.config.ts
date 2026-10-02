import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { readFileSync } from 'node:fs';

let local: { server?: { port?: number; certPath?: string; keyPath?: string } } = {};
try { local = JSON.parse(readFileSync(new URL('../../config/local.json', import.meta.url), 'utf8')); }
catch { /* Setup has not generated the local configuration yet. */ }
const scheme = local.server?.certPath && local.server?.keyPath ? 'https' : 'http';
const proxyTarget = process.env.MOFOX_DEV_API_TARGET || `${scheme}://127.0.0.1:${local.server?.port || 8789}`;

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5180,
    proxy: Object.fromEntries(['/api', '/ws', '/models', '/vendor'].map(path => [path, {
      target: proxyTarget, changeOrigin: false, ws: path === '/ws',
      // Local development may proxy the host's self-signed HTTPS certificate.
      // The production page is served directly by the HTTPS backend.
      secure: false
    }]))
  },
  build: { target: 'es2022', assetsInlineLimit: 0 }
});
