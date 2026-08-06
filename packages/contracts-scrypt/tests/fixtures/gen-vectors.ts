// Generates @pm/lmsr ground-truth vectors for the sCrypt equivalence tests. Run from the MONOREPO context
// (pnpm), where @pm/lmsr resolves, e.g.: `npx tsx packages/contracts-scrypt/tests/fixtures/gen-vectors.ts`.
// contracts-scrypt is npm-managed/excluded from the workspace, so it can't import @pm/lmsr directly — it reads
// the emitted vectors.json instead. This keeps the sCrypt contract provably matched to the integer reference.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WAD, initState, unitMultiplier, unitInverseMultiplier, maxLossSats,
  applyUnitBuy, applyUnitSell, buyChargeApproxSats, sellPayoutApproxSats, powFixed, type MarketParams,
} from '@pm/lmsr';

const bUnits = 10n;
const p: MarketParams = { b: bUnits * WAD, payoutUnit: 100_000n, unit: WAD };
const s0 = initState(p);
const mult = unitMultiplier(p);
const invMult = unitInverseMultiplier(p);
const collateral = maxLossSats(p);

// buyYes once off the fresh pool
const afterBuyYes = applyUnitBuy(s0, 'yes', mult, p);
const buyYesCharge = buyChargeApproxSats(afterBuyYes, 'yes', p.unit, p);
// stock 2 YES then sell one back
const stocked = applyUnitBuy(afterBuyYes, 'yes', mult, p);
const afterSell = applyUnitSell(stocked, 'yes', invMult, p);
const sellProceeds = sellPayoutApproxSats(afterSell, 'yes', p.unit, p);

const S = (x: bigint) => x.toString();

// CONC-006: square-and-multiply pow vectors. The sCrypt contract's `settle` and the engines run the SAME
// routine, so these pin all three implementations to @pm/lmsr's canonical `powFixed`.
const POW_EXPS = [0n, 1n, 2n, 3n, 20n, 100n, 530n, 1023n, 4095n];
const pow = {
  exps: POW_EXPS.map(S),
  mult: POW_EXPS.map((n) => S(powFixed(mult, n))),
  invMult: POW_EXPS.map((n) => S(powFixed(invMult, n))),
};

const vectors = {
  pow,
  bUnits: S(bUnits), WAD: S(WAD), payoutUnit: S(p.payoutUnit), unit: S(p.unit),
  mult: S(mult), invMult: S(invMult), collateral: S(collateral),
  init: { eYes: S(s0.eYes), eNo: S(s0.eNo) },
  buyYes: { charge: S(buyYesCharge), eYes: S(afterBuyYes.eYes), eNo: S(afterBuyYes.eNo), qYes: S(afterBuyYes.qYes) },
  stocked: { eYes: S(stocked.eYes), eNo: S(stocked.eNo), qYes: S(stocked.qYes) },
  afterSellYes: { proceeds: S(sellProceeds), eYes: S(afterSell.eYes), eNo: S(afterSell.eNo), qYes: S(afterSell.qYes) },
};
const out = join(dirname(fileURLToPath(import.meta.url)), 'vectors.json');
writeFileSync(out, JSON.stringify(vectors, null, 2));
console.log('wrote', out);
console.log(vectors);
