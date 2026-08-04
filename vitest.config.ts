import { defineConfig } from 'vitest/config'

// The Rúnar packages + daemon test under vitest (ESM). packages/contracts-scrypt is an npm-managed sCrypt
// subproject with its own mocha runner (CommonJS + ts-patch) — exclude it so `pnpm test` doesn't try to run
// its tests under vitest. Run those with `npm --prefix packages/contracts-scrypt test`.
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', 'packages/contracts-scrypt/**'],
  },
})
