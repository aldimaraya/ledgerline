import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Ledgerline',
        short_name: 'Ledgerline',
        description: 'Net worth, at a glance.',
        start_url: '/',
        display: 'standalone',
        background_color: '#14100D',
        theme_color: '#14100D',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        runtimeCaching: [
          {
            // Cache the last known number so a cold open on bad signal shows something
            // rather than a spinner. NetworkFirst, not CacheFirst: a stale balance shown
            // as current is the one thing this app must never do, so the network wins
            // whenever it can answer within a few seconds.
            urlPattern: /\/api\/networth$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'networth',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 1, maxAgeSeconds: 60 * 60 * 24 * 7 },
            },
          },
          {
            urlPattern: /\/api\/history/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'history',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 7 },
            },
          },
        ],
      },
    }),
  ],
  server: {
    // `npm run dev` talks to the real server so the app is never developed against
    // invented data.
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
  build: { outDir: 'dist' },
});
