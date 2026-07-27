import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'runar-compiler';
import { RunarContract } from 'runar-sdk';
import {
  WAD, initState, unitMultiplier, unitInverseMultiplier, maxLossSats, type MarketParams,
} from '@pm/lmsr';
import { RABIN_TEST_KEY } from 'runar-testing';

const DIR = dirname(fileURLToPath(import.meta.url));
const CONTRACT = join(DIR, '..', '..', '..', 'packages', 'contracts', 'src', 'LMSRMarket.runar.ts');
const SHARE_TOKEN = join(DIR, '..', '..', '..', 'packages', 'contracts', 'src', 'ShareToken.runar.ts');

export const MARKET_TAG = 'a1b2c3d4';
export const MARKET_ID = 42n;

/** ShareToken code template (code part + OP_RETURN) for (MARKET_ID, side); strip the 41-byte state suffix. */
export function tokenCode(side: bigint): string {
  const art = compile(readFileSync(SHARE_TOKEN, 'utf8'), { fileName: 'ShareToken.runar.ts' }).artifact!;
  const dummyHolder = '02' + 'ab'.repeat(32); // holder is in the stripped state; any 33-byte pk works
  const full = new RunarContract(art, [1n, dummyHolder, MARKET_ID, side]).getLockingScript();
  return full.slice(0, full.length - 82);
}

/** Compile LMSRMarket → artifact (throws on any diagnostic error). */
export function compileMarket() {
  const source = readFileSync(CONTRACT, 'utf8');
  const r = compile(source, { fileName: 'LMSRMarket.runar.ts' });
  if (!r.success) throw new Error('compile failed: ' + JSON.stringify(r.diagnostics, null, 2));
  return r.artifact!;
}

/** Market params + initial constructor args + initial state for a given liquidity b (in share-units). */
export function marketSetup(bUnits: bigint, payoutUnit = 100_000n) {
  const p: MarketParams = { b: bUnits * WAD, payoutUnit, unit: WAD };
  const s0 = initState(p);
  const collateral = maxLossSats(p);
  const mult = unitMultiplier(p);
  const invMult = unitInverseMultiplier(p);
  const oracleN = RABIN_TEST_KEY.n;

  const tokenCodeYes = tokenCode(1n);
  const tokenCodeNo = tokenCode(0n);

  // constructor order must match LMSRMarket.runar.ts:
  // eYes, eNo, qYes, qNo, collateral, resolved, winner, mult, invMult, payoutUnit, scale, unit,
  // oracleN, marketTag, tokenCodeYes, tokenCodeNo
  const constructorArgs: unknown[] = [
    s0.eYes, s0.eNo, 0n, 0n, collateral, 0n, 0n, mult, invMult, payoutUnit, WAD, WAD, oracleN, MARKET_TAG,
    tokenCodeYes, tokenCodeNo,
  ];
  const state0: Record<string, unknown> = {
    eYes: s0.eYes, eNo: s0.eNo, qYes: 0n, qNo: 0n, collateral, resolved: 0n, winner: 0n,
    mult, invMult, payoutUnit, scale: WAD, unit: WAD, oracleN, marketTag: MARKET_TAG,
    tokenCodeYes, tokenCodeNo,
  };
  return { p, s0, collateral, mult, invMult, payoutUnit, oracleN, tokenCodeYes, tokenCodeNo, constructorArgs, state0 };
}
