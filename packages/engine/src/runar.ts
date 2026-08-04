// RunarEngine — the Rúnar/BSV implementation of ChainEngine. Absorbs the tx-building proven live on mainnet
// (apps/spike/src/mainnet.ts): deploy funds a pool UTXO via @bsv/sdk; buy/sell/resolve spend the pool via
// runar-sdk prepareCall (OP_PUSH_TX) and re-sign the funding inputs with @bsv/sdk over the final tx (the
// BUG-001 workaround). Token-minting buys and multi-input redeems hit runar-sdk BUG-005 → EngineLimitation.
import { Transaction, P2PKH, PrivateKey, Script } from '@bsv/sdk';
import { WhatsOnChainProvider, RunarContract } from 'runar-sdk';
import { RABIN_TEST_KEY, rabinSign, hexToBytes } from 'runar-testing';
import {
  WAD, applyUnitBuy, applyUnitSell, buyChargeApproxSats, sellPayoutApproxSats,
  unitMultiplier, unitInverseMultiplier, type MarketParams, type MarketState,
} from '@pm/lmsr';
import { compileMarket, marketSetup, MARKET_TAG } from './market.js';
import { BsvSigner } from './bsv-signer.js';
import { fundingWif } from './env.js';
import { EngineLimitation } from './types.js';
import type {
  ChainEngine, MarketConfig, PoolRef, PoolState, Side, TxPlan, TxEffects, BroadcastResult, Utxo,
} from './types.js';

// Fee previews for the sign-off queue (measured live: deploy ≈176 sat, trade ≈510 sat). The real fee is
// computed by @bsv/sdk at authorize time; these only populate the human-readable spend estimate.
const FEE_DEPLOY = 200;
const FEE_TRADE = 550;

type ArgSpec = { t: 'int' | 'hex'; v: string };
interface PoolDescriptor { txid: string; vout: number; satoshis: number; lockingScript: string }
interface DeployBuild { deploySats: number; lockingScript: string }
interface CallBuild { method: string; args: ArgSpec[]; pool: PoolDescriptor; newState: Record<string, string> }

const strState = (s: PoolState): Record<string, string> => ({
  eYes: s.eYes.toString(), eNo: s.eNo.toString(), qYes: s.qYes.toString(), qNo: s.qNo.toString(),
  collateral: s.collateral.toString(), resolved: s.resolved.toString(), winner: s.winner.toString(),
});
const bnState = (r: Record<string, string>): PoolState => ({
  eYes: BigInt(r.eYes!), eNo: BigInt(r.eNo!), qYes: BigInt(r.qYes!), qNo: BigInt(r.qNo!),
  collateral: BigInt(r.collateral!), resolved: BigInt(r.resolved!), winner: BigInt(r.winner!),
});
const params = (cfg: MarketConfig): MarketParams => ({ b: cfg.bUnits * WAD, payoutUnit: cfg.payoutUnit, unit: WAD });
const stateOf = (pool: PoolRef): MarketState => ({ eYes: pool.state.eYes, eNo: pool.state.eNo, qYes: pool.state.qYes, qNo: pool.state.qNo });
const descriptor = (pool: PoolRef): PoolDescriptor => ({ txid: pool.txid, vout: pool.vout, satoshis: pool.satoshis, lockingScript: pool.lockingScript });

/** Little-endian hex of a bigint — the padding encoding the contract's verifyRabinSig expects. */
function leHex(n: bigint): string {
  if (n === 0n) return '00';
  let h = n.toString(16);
  if (h.length % 2) h = '0' + h;
  return (h.match(/../g) as string[]).reverse().join('');
}
/** The exact message the contract hashes for resolution: marketTag ‖ num2bin(outcome, 1). */
function oracleMsgBytes(outcome: bigint): Uint8Array {
  return new Uint8Array([...hexToBytes(MARKET_TAG), Number(outcome)]);
}

export class RunarEngine implements ChainEngine {
  readonly name: string = 'runar';
  private readonly network: 'mainnet' | 'testnet';
  constructor(network: 'mainnet' | 'testnet' = 'mainnet') {
    this.network = network;
  }
  private provider() {
    return new WhatsOnChainProvider(this.network);
  }

  async fundingAddress(): Promise<string> {
    // Derives the PUBLIC address from the WIF in-memory; the address is public, the key never leaves this call.
    return PrivateKey.fromWif(fundingWif()).toAddress();
  }

  async fundingPublicKey(): Promise<string> {
    return PrivateKey.fromWif(fundingWif()).toPublicKey().toDER('hex') as string;
  }

  oracleId(): string {
    return RABIN_TEST_KEY.n.toString(16); // mock Rabin oracle modulus (runar-testing RABIN_TEST_KEY)
  }

  async getUtxos(address: string): Promise<Utxo[]> {
    const utxos = await this.provider().getUtxos(address);
    return utxos.map((u) => ({ txid: u.txid, outputIndex: u.outputIndex, satoshis: u.satoshis, script: u.script }));
  }

  async buildDeploy(cfg: MarketConfig, deploySats: number): Promise<TxPlan> {
    const { s0, collateral, constructorArgs } = marketSetup(cfg.bUnits, cfg.payoutUnit);
    const lockingScript = new RunarContract(compileMarket(), [...constructorArgs]).getLockingScript();
    const effects: TxEffects = {
      pool: { vout: 0, satoshis: deploySats, eYes: s0.eYes.toString(), eNo: s0.eNo.toString(), qYes: '0', qNo: '0', collateral: collateral.toString(), resolved: 0, winner: 0, lockingScript },
      spendsPrevPool: false,
      marketState: 'deployed',
    };
    const build: DeployBuild = { deploySats, lockingScript };
    return {
      kind: 'deploy',
      summary: `deploy LMSR pool (b=${cfg.bUnits} units, ${deploySats} dust sats + fee)`,
      spendSats: deploySats + FEE_DEPLOY,
      build,
      effects,
    };
  }

  async buildBuy(cfg: MarketConfig, pool: PoolRef, side: Side, shares: bigint): Promise<TxPlan> {
    if (shares !== 1n) {
      throw new EngineLimitation('buy', 'multi-share buy needs bounded pow / funding-UTXO chaining (BUG-003) — Phase 2 (sCrypt). Buy one share per call for now.');
    }
    const p = params(cfg);
    const next = applyUnitBuy(stateOf(pool), side, unitMultiplier(p), p);
    const charge = buyChargeApproxSats(next, side, p.unit, p);
    const newState: PoolState = { eYes: next.eYes, eNo: next.eNo, qYes: next.qYes, qNo: next.qNo, collateral: pool.state.collateral + charge, resolved: 0n, winner: 0n };
    const method = side === 'yes' ? 'buyYesPlain' : 'buyNoPlain';
    const build: CallBuild = {
      method,
      args: [{ t: 'int', v: charge.toString() }, { t: 'int', v: pool.satoshis.toString() }],
      pool: descriptor(pool),
      newState: strState(newState),
    };
    const effects: TxEffects = {
      pool: { vout: 0, satoshis: pool.satoshis, eYes: next.eYes.toString(), eNo: next.eNo.toString(), qYes: next.qYes.toString(), qNo: next.qNo.toString(), collateral: newState.collateral.toString(), resolved: 0, winner: 0, lockingScript: '' },
      spendsPrevPool: true,
      trade: { side, action: 'buy', shares: WAD.toString(), costSats: Number(charge) },
      marketState: 'trading',
    };
    return { kind: 'buy', summary: `buy 1 ${side.toUpperCase()} share → charge ${charge} sat (state-only; position tracked off-chain)`, spendSats: FEE_TRADE, build, effects };
  }

  async buildSell(cfg: MarketConfig, pool: PoolRef, side: Side, shares: bigint): Promise<TxPlan> {
    if (shares !== 1n) throw new EngineLimitation('sell', 'multi-share sell needs bounded pow — Phase 2. Sell one share per call.');
    const p = params(cfg);
    const held = side === 'yes' ? pool.state.qYes : pool.state.qNo;
    if (held < p.unit) throw new Error(`pool has no outstanding ${side.toUpperCase()} to sell`);
    const next = applyUnitSell(stateOf(pool), side, unitInverseMultiplier(p), p);
    const proceeds = sellPayoutApproxSats(next, side, p.unit, p);
    const newState: PoolState = { eYes: next.eYes, eNo: next.eNo, qYes: next.qYes, qNo: next.qNo, collateral: pool.state.collateral - proceeds, resolved: 0n, winner: 0n };
    const method = side === 'yes' ? 'sellYes' : 'sellNo';
    const build: CallBuild = {
      method,
      args: [{ t: 'int', v: pool.satoshis.toString() }],
      pool: descriptor(pool),
      newState: strState(newState),
    };
    const effects: TxEffects = {
      pool: { vout: 0, satoshis: pool.satoshis, eYes: next.eYes.toString(), eNo: next.eNo.toString(), qYes: next.qYes.toString(), qNo: next.qNo.toString(), collateral: newState.collateral.toString(), resolved: 0, winner: 0, lockingScript: '' },
      spendsPrevPool: true,
      trade: { side, action: 'sell', shares: WAD.toString(), costSats: Number(proceeds) },
      marketState: 'trading',
    };
    return { kind: 'sell', summary: `sell 1 ${side.toUpperCase()} share → proceeds ${proceeds} sat (state-only)`, spendSats: FEE_TRADE, build, effects };
  }

  async buildResolve(cfg: MarketConfig, pool: PoolRef, outcome: Side): Promise<TxPlan> {
    const outcomeN = outcome === 'yes' ? 1n : 0n;
    const { sig, padding } = rabinSign(oracleMsgBytes(outcomeN), RABIN_TEST_KEY);
    const newState: PoolState = { ...pool.state, resolved: 1n, winner: outcomeN };
    const build: CallBuild = {
      method: 'resolve',
      args: [
        { t: 'int', v: sig.toString() },
        { t: 'hex', v: leHex(padding) },
        { t: 'int', v: outcomeN.toString() },
        { t: 'int', v: pool.satoshis.toString() },
      ],
      pool: descriptor(pool),
      newState: strState(newState),
    };
    const effects: TxEffects = {
      pool: { vout: 0, satoshis: pool.satoshis, eYes: pool.state.eYes.toString(), eNo: pool.state.eNo.toString(), qYes: pool.state.qYes.toString(), qNo: pool.state.qNo.toString(), collateral: pool.state.collateral.toString(), resolved: 1, winner: outcomeN === 1n ? 1 : 0, lockingScript: '' },
      spendsPrevPool: true,
      marketState: 'resolved',
      resolution: outcome,
    };
    return { kind: 'resolve', summary: `resolve market ${outcome.toUpperCase()} (mock-oracle Rabin sig, verified on-chain)`, spendSats: FEE_TRADE, build, effects };
  }

  async buildRedeem(_cfg: MarketConfig, _pool: PoolRef, _side: Side, _shares: bigint): Promise<TxPlan> {
    throw new EngineLimitation('redeem', 'winner payout uses addRawOutput + a multi-input token burn the SDK cannot build (BUG-005) — unblocked by Phase 2 (sCrypt). The full mint→resolve→redeem lifecycle is VM-proven.');
  }

  async authorizeAndBroadcast(plan: TxPlan): Promise<BroadcastResult> {
    const wif = fundingWif(); // loaded ONLY here — never returned, logged, or persisted
    if (plan.kind === 'deploy') return this.execDeploy(plan.build as DeployBuild, wif);
    return this.execCall(plan.build as CallBuild, wif);
  }

  // ── authorize-time execution (the only chain writes) ────────────────────────────────────────────────

  private async execDeploy(b: DeployBuild, wif: string): Promise<BroadcastResult> {
    const provider = this.provider();
    const priv = PrivateKey.fromWif(wif);
    const address = priv.toAddress();
    const utxos = await provider.getUtxos(address);
    if (!utxos.length) throw new Error(`no funding UTXOs at ${address}`);
    const funding = [...utxos].sort((a, z) => z.satoshis - a.satoshis)[0]!; // largest covers the fee
    const sourceTransaction = Transaction.fromHex(await provider.getRawTransaction(funding.txid));

    const tx = new Transaction();
    tx.addInput({ sourceTransaction, sourceOutputIndex: funding.outputIndex, unlockingScriptTemplate: new P2PKH().unlock(priv) });
    tx.addOutput({ lockingScript: Script.fromHex(b.lockingScript), satoshis: b.deploySats });
    tx.addOutput({ lockingScript: new P2PKH().lock(address), change: true });
    await tx.fee();
    await tx.sign();
    const txid = await provider.broadcast(tx);
    return { txid, poolLockingScript: b.lockingScript };
  }

  private async execCall(b: CallBuild, wif: string): Promise<BroadcastResult> {
    const provider = this.provider();
    const contract = RunarContract.fromUtxo(compileMarket(), {
      txid: b.pool.txid, outputIndex: b.pool.vout, satoshis: b.pool.satoshis, script: b.pool.lockingScript,
    });
    contract.connect(provider, new BsvSigner(wif));

    const args = b.args.map((a) => (a.t === 'int' ? BigInt(a.v) : a.v));
    const newState = bnState(b.newState) as unknown as Record<string, unknown>;
    const prepared = await contract.prepareCall(b.method, args, { newState, satoshis: b.pool.satoshis });
    const tx = prepared.tx;

    // Re-sign the funding inputs (index ≥ 1) with @bsv/sdk over the FINAL tx (BUG-001 workaround). The
    // contract input's OP_PUSH_TX sig commits to the outputs, which don't change, so it stays valid.
    const priv = PrivateKey.fromWif(wif);
    const fundingLock = new P2PKH().lock(priv.toAddress()); // WoC getUtxos returns empty .script → build it
    const utxos = await provider.getUtxos(priv.toAddress());
    const byOutpoint = new Map(utxos.map((u) => [`${u.txid}:${u.outputIndex}`, u]));
    for (let i = 1; i < tx.inputs.length; i++) {
      const inp = tx.inputs[i]!;
      const u = byOutpoint.get(`${inp.sourceTXID}:${inp.sourceOutputIndex}`);
      if (!u) throw new Error(`funding utxo not found for input ${i} (${inp.sourceTXID}:${inp.sourceOutputIndex})`);
      inp.unlockingScript = await new P2PKH().unlock(priv, 'all', false, u.satoshis, fundingLock).sign(tx, i);
    }
    const txid = await provider.broadcast(tx);
    return { txid, poolLockingScript: tx.outputs[0]!.lockingScript!.toHex() };
  }
}
