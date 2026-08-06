import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The daemon binds 127.0.0.1 only; the app talks to it directly (CORS is allowed for localhost origins).
export default defineConfig({
  plugins: [react()],
  server: { port: 5273, strictPort: true },
});
