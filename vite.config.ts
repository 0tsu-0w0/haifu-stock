import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: '頒布レジ',
        short_name: '頒布レジ',
        description: '同人イベントの頒布物・在庫・売上を記録するアプリ',
        lang: 'ja',
        start_url: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#EEF0F3',
        theme_color: '#2340C8',
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        // 会場で電波がなくても開けるよう、画面と資源をすべて端末に置く
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        navigateFallback: '/index.html',
      },
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('@supabase')) return 'supabase';
          if (id.includes('dexie')) return 'dexie';
          if (id.includes('qrcode')) return 'qrcode';
          if (/[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) return 'react';
          return 'vendor';
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['fake-indexeddb/auto'],
  },
});
