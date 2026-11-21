import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Go server embeds ../internal/server/dist.
// For frontend dev: run the Go server on :8765, then `npm run dev`.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../internal/server/dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8765',
      '/files': 'http://127.0.0.1:8765',
      '/thumbs': 'http://127.0.0.1:8765',
      '/avatars': 'http://127.0.0.1:8765',
      '/emoji': 'http://127.0.0.1:8765',
    },
  },
});
