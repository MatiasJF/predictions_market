import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The daemon binds 127.0.0.1 only; the app talks to it directly (CORS is allowed for localhost origins).
export default defineConfig({
  plugins: [react()],
  // Port from the environment, not from an argument. `pnpm --filter @pm/web dev -- --port N` does not reach
  // vite — the `--` survives as a literal and the flag is ignored, so the server silently keeps this default
  // and dies on a port the caller thought it had overridden.
  //
  // `strictPort` stays: sliding to the next free port would mean the app is not where anything was told it is.
  server: { port: Number(process.env.PM_WEB_PORT ?? 5273), strictPort: true },
});
