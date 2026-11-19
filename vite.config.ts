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
          description: 'Gestione inventario cucina in tempo reale.',
          theme_color: '#ffffff',
          background_color: '#ffffff',
          display: 'standalone',
          start_url: '/',
          scope: '/',
          icons: [
            {
              src: 'https://cdn-icons-png.flaticon.com/512/3652/3652191.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any',
            },
            {
              src: 'https://cdn-icons-png.flaticon.com/512/3652/3652191.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            }
          ],
        },
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
