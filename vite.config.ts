import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';
import {VitePWA} from 'vite-plugin-pwa';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), VitePWA({
        registerType: 'autoUpdate',
        manifest: {
          id: '/',
          name: 'KitchenOS',
          short_name: 'KitchenOS',
          description: 'Richieste merce e ordini di cucina in tempo reale.',
          theme_color: '#ffffff',
          background_color: '#ffffff',
          display: 'standalone',
          start_url: '/',
          scope: '/',
          icons: [
            { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        includeAssets: ['favicon.ico', 'favicon-32.png', 'icon-192.png', 'icon-512.png', 'badge-96.png', 'apple-touch-icon.png'],
        // Un solo service worker: quello dell'app include anche la gestione delle notifiche push.
        workbox: { importScripts: ['firebase-messaging-sw.js'] },
        devOptions: {
            enabled: true,
            type: 'module',
        },
    })],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
