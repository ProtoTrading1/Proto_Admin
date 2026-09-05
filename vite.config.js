import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Keep lucide (and other vendors) out of the entry chunk so lazy panels
        // don't circular-import back into index and fail module loading.
        manualChunks(id) {
          if (id.includes('node_modules/lucide-react')) return 'lucide';
          if (id.includes('node_modules/@tanstack/react-query')) return 'query';
          // Supabase (~120KB) rarely changes — split it so it caches long-term
          // instead of riding the entry chunk that busts on every deploy.
          if (id.includes('node_modules/@supabase')) return 'supabase';
        },
      },
    },
  },
})
