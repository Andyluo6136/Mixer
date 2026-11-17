import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Spotify doesn't accept "localhost" redirect URIs, so serve on the loopback IP instead.
  // strictPort: fail rather than silently moving to another port (the redirect URI wouldn't match).
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
})
