// Does prepareCall build the addRawOutput token output into the tx? Offline check (MockProvider).
import { RunarContract, MockProvider, LocalSigner, buildP2PKHScript } from 'runar-sdk';
import { applyUnitBuy, buyChargeApproxSats } from '@pm/lmsr';
import { compileMarket, marketSetup } from './market.js';

async function main(): Promise<void> {
  const artifact = compileMarket();
  const { p, mult, collateral, constructorArgs, state0 } = marketSetup(10n);

  const lockingScript = new RunarContract(artifact, [...constructorArgs]).getLockingScript();
  const provider = new MockProvider('mainnet');
  const signer = new LocalSigner('01'.repeat(32));
  const address = await signer.getAddress();
  const buyerPk = await signer.getPublicKey();
  provider.addUtxo(address, { txid: 'ff'.repeat(32), outputIndex: 0, satoshis: 100_000_000, script: buildP2PKHScript(address) });

  const poolUtxo = { txid: 'aa'.repeat(32), outputIndex: 0, satoshis: Number(collateral), script: lockingScript };
  const contract = RunarContract.fromUtxo(artifact, poolUtxo);
  contract.connect(provider, signer);

  const next = applyUnitBuy({ eYes: BigInt(state0.eYes as bigint), eNo: BigInt(state0.eNo as bigint), qYes: 0n, qNo: 0n }, 'yes', mult, p);
  const charge = buyChargeApproxSats(next, 'yes', p.unit, p);
  const newSats = Number(collateral) + Number(charge);
  const newState = { ...state0, eYes: next.eYes, eNo: next.eNo, qYes: next.qYes, qNo: next.qNo, collateral: BigInt(newSats) };

  const prepared = await contract.prepareCall('buyYes', [charge, BigInt(newSats), buyerPk, 1n], { newState, satoshis: newSats });
  console.log('tx outputs:');
  prepared.tx.outputs.forEach((o, i) => {
    const hex = o.lockingScript!.toHex();
    console.log(`  [${i}] sats=${o.satoshis} len=${hex.length / 2} head=${hex.slice(0, 24)}`);
  });
}
main().catch((e) => { console.error(String(e).slice(0, 300)); process.exit(1); });
