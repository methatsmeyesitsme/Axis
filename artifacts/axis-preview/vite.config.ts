import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

// Defaults so forge/preview builds don't fail when env is minimal
const rawPort = process.env.PORT || '5000';
const port = Number(rawPort);
const basePath = process.env.BASE_PATH || './';

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    // Dev-only Replit plugins — never load during production/forge builds
    ...(process.env.NODE_ENV !== 'production' &&
    process.env.REPL_ID !== undefined &&
    process.env.FORGE_FAST_BUILD !== '1'
      ? [
          await import('@replit/vite-plugin-cartographer').then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, '..'),
            }),
          ),
          await import('@replit/vite-plugin-dev-banner').then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
    // Speed: skip gzip size report + use esbuild minify only when enabled
    reportCompressedSize: false,
    sourcemap: false,
    cssCodeSplit: false,
    target: 'esnext',
    minify: process.env.FORGE_FAST_BUILD === '1' ? false : 'esbuild',
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: Number.isNaN(port) || port <= 0 ? 5000 : port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port: Number.isNaN(port) || port <= 0 ? 5000 : port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
