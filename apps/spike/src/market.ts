// Market compile + setup now live in @pm/engine (shared by the CLI and the daemon). Re-exported here so the
// existing spike scripts (mainnet/measure/diag-*) keep importing from './market.js' unchanged.
export { compileMarket, marketSetup, tokenCode, MARKET_TAG, MARKET_ID } from '@pm/engine';
