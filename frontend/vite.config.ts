import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from "path"

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss()
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    // ChatPage (the landing route) pulls in react-markdown and
    // @dicebear which keep the main + shared vendor chunks above 500kB.
    // Lazy-loading already splits admin/settings/people/memory pages
    // into their own chunks; further splitting requires restructuring
    // ChatPage internals. 800kB is a reasonable ceiling for the two
    // remaining shared chunks.
    chunkSizeWarningLimit: 800,
  },
})
