// Offline measurement: build the real deploy + buy transactions through MockProvider (no chain, no funds)
// and return their byte sizes → per-trade fee (feasibility unknown #6). Shared by the CLI and the test.
import { MockProvider, LocalSigner, RunarContract, buildP2PKHScript } from 'runar-sdk';
import { applyUnitBuy, buyChargeApproxSats } from '@pm/lmsr';
import { compileMarket, marketSetup } from './market.js';

const DEV_KEY = '01'.repeat(32); // 64 hex chars = 32-byte key — MOCK ONLY, never a real key / never funded

export interface DryRunResult {
  feeRate: number;
  deployBytes: number;
  buyBytes: number[];
}

const sizeOf = (tx: { toHex(): string }): number => tx.toHex().length / 2;

/** Build a deploy + `nBuys` sequential buys entirely offline and return the tx byte sizes. */
export async function runDryRun(nBuys = 3, feeRate = 0.05): Promise<DryRunResult> {
  const artifact = compileMarket();
  const { p, s0, collateral, mult, state0, constructorArgs } = marketSetup(1000n);

  const provider = new MockProvider('mainnet');
  const signer = new LocalSigner(DEV_KEY);
  const address = await signer.getAddress();
  provider.setFeeRate(feeRate);
  provider.addUtxo(address, {
    txid: 'ff'.repeat(32), outputIndex: 0, satoshis: 5_000_000_000, script: buildP2PKHScript(address),
  });

  const contract = new RunarContract(artifact, [...constructorArgs]);
  contract.connect(provider, signer);
  const last = () => provider.getBroadcastedTxObjects().at(-1)!;

  // MockProvider doesn't serve broadcast txs back to getTransaction, so the SDK's post-broadcast
  // confirmation re-fetch logs a benign warning. Silence it around the (successful) builds.
  const origErr = console.error;
  console.error = () => {};
  try {
    await contract.deploy({ satoshis: Number(collateral) });
    const deployBytes = sizeOf(last());

    const buyBytes: number[] = [];
    let ref = s0;
    let poolSats = Number(collateral);
    for (let i = 0; i < nBuys; i++) {
      const next = applyUnitBuy(ref, 'yes', mult, p);
      const charge = buyChargeApproxSats(next, 'yes', p.unit, p);
      poolSats += Number(charge);
      const newState = {
        ...state0, eYes: next.eYes, eNo: next.eNo, qYes: next.qYes, qNo: next.qNo, collateral: BigInt(poolSats),
      };
      await contract.call('buyYes', [charge, BigInt(poolSats)], { newState, satoshis: poolSats });
      buyBytes.push(sizeOf(last()));
      ref = next;
    }
    return { feeRate, deployBytes, buyBytes };
  } finally {
    console.error = origErr;
  }
}
