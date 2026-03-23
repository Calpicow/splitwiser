/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig(() => ({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
  },
  server: {
    // Allow all hosts in dev mode for network access (e.g., testing from other devices)
    // This only affects the dev server, not production builds
    allowedHosts: process.env.SPLITWISER_DEV === 'true' ? true as const : undefined,
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'apple-touch-icon.png'],
      manifest: {
        name: 'Splitwiser',
        short_name: 'Splitwiser',
        description: 'Split expenses with friends and groups',
        theme_color: '#14b8a6',
        background_color: '#1f2937',
        display: 'standalone',
        orientation: 'portrait-primary',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png'
          },
          {
            src: 'pwa-maskable-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable'
          },
          {
            src: 'pwa-maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // Clean up old caches from previous versions
        cleanupOutdatedCaches: true,
        // Skip waiting so new service worker activates immediately when user accepts update
        skipWaiting: true,
        clientsClaim: true,
        runtimeCaching: [
          // API responses - Network first with cache fallback
          {
            urlPattern: /^https?:\/\/.*\/api\/(groups|expenses|balances|friends)/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 60 * 60 * 24 * 7 // 1 week
              },
              networkTimeoutSeconds: 10,
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          },
          // Exchange rates - Stale while revalidate
          {
            urlPattern: /^https?:\/\/.*\/api\/exchange_rates/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'exchange-rates-cache',
              expiration: {
                maxEntries: 1,
                maxAgeSeconds: 60 * 60 * 24 // 24 hours
              }
            }
          },
          // Static assets - Cache first
          {
            urlPattern: /\.(?:png|jpg|jpeg|svg|gif|webp)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'images-cache',
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 60 * 60 * 24 * 30 // 30 days
              }
            }
          }
        ]
      }
    })
  ],
}))
