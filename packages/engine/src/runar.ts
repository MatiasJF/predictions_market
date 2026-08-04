// RunarEngine — the Rúnar/BSV implementation of ChainEngine. Absorbs the tx-building proven live on mainnet
// (apps/spike/src/mainnet.ts): deploy funds a pool UTXO via @bsv/sdk; buy/sell/resolve spend the pool via
// runar-sdk prepareCall (OP_PUSH_TX) and re-sign the funding inputs with @bsv/sdk over the final tx (the
// BUG-001 workaround). Token-minting buys and multi-input redeems hit runar-sdk BUG-005 → EngineLimitation.
//
// Multi-share buy/sell (API-009): a call carries N unit STEPS. authorize builds a 0-conf CHAIN of N txs —
// each spends the previous tx's pool output + change output — via a ChainingProvider overlay (a client-side
// workaround for BUG-003, which otherwise makes the SDK re-select the already-spent confirmed funding UTXO).
// Only the FINAL pool UTXO persists; the intermediates are created and spent inside the chain.
import { Transaction, P2PKH, PrivateKey, Script } from '@bsv/sdk';
import { WhatsOnChainProvider, RunarContract } from 'runar-sdk';
import { RABIN_TEST_KEY, rabinSign, hexToBytes } from 'runar-testing';
import {
  WAD, applyUnitBuy, applyUnitSell, buyChargeApproxSats, sellPayoutApproxSats,
  unitMultiplier, unitInverseMultiplier, type MarketParams, type MarketState,
} from '@pm/lmsr';
import { compileMarket, marketSetup, MARKET_TAG } from './market.js';
import { BsvSigner } from './bsv-signer.js';
import { ChainingProvider } from './chaining-provider.js';
import { fundingWif } from './env.js';
import { EngineLimitation } from './types.js';
import type {
  ChainEngine, MarketConfig, PoolRef, PoolState, Side, TxPlan, TxEffects, BroadcastResult, Utxo,
} from './types.js';

// Fee previews for the sign-off queue (measured live: deploy ≈176 sat, trade ≈510 sat). The real fee is
// computed by @bsv/sdk at authorize time; these only populate the human-readable spend estimate.
const FEE_DEPLOY = 200;
const FEE_TRADE = 550;
// Max unit-steps per multi-share call. A 0-conf chain this long is already extreme; the service also validates.
export const MAX_UNITS = 100;

type ArgSpec = { t: 'int' | 'hex'; v: string };
interface PoolDescriptor { txid: string; vout: number; satoshis: number; lockingScript: string }
interface DeployBuild { deploySats: number; lockingScript: string }
interface CallStep { method: string; args: ArgSpec[]; newState: Record<string, string> }
interface CallBuild { pool: PoolDescriptor; steps: CallStep[] }

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

const poolEffect = (satoshis: number, s: MarketState, collateral: bigint, resolved: 0 | 1, winner: 0 | 1) => ({
  vout: 0, satoshis, eYes: s.eYes.toString(), eNo: s.eNo.toString(), qYes: s.qYes.toString(), qNo: s.qNo.toString(),
  collateral: collateral.toString(), resolved, winner, lockingScript: '',
});

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
      pool: { ...poolEffect(deploySats, s0, collateral, 0, 0), lockingScript },
      spendsPrevPool: false,
      marketState: 'deployed',
    };
    const build: DeployBuild = { deploySats, lockingScript };
    return { kind: 'deploy', summary: `deploy LMSR pool (b=${cfg.bUnits} units, ${deploySats} dust sats + fee)`, spendSats: deploySats + FEE_DEPLOY, build, effects };
  }

  async buildBuy(cfg: MarketConfig, pool: PoolRef, side: Side, shares: bigint): Promise<TxPlan> {
    const n = requireUnits('buy', shares);
    const p = params(cfg);
    const mult = unitMultiplier(p);
    const method = side === 'yes' ? 'buyYesPlain' : 'buyNoPlain';
    let s = stateOf(pool); let collateral = pool.state.collateral; let total = 0n;
    const steps: CallStep[] = [];
    for (let i = 0; i < n; i++) {
      const next = applyUnitBuy(s, side, mult, p);
      const charge = buyChargeApproxSats(next, side, p.unit, p);
      collateral += charge; total += charge;
      steps.push({ method, args: [intArg(charge), intArg(BigInt(pool.satoshis))], newState: strState({ eYes: next.eYes, eNo: next.eNo, qYes: next.qYes, qNo: next.qNo, collateral, resolved: 0n, winner: 0n }) });
      s = next;
    }
    const effects: TxEffects = {
      pool: poolEffect(pool.satoshis, s, collateral, 0, 0),
      spendsPrevPool: true,
      trade: { side, action: 'buy', shares: (shares * WAD).toString(), costSats: Number(total) },
      marketState: 'trading',
    };
    const build: CallBuild = { pool: descriptor(pool), steps };
    return { kind: 'buy', summary: `buy ${n} ${side.toUpperCase()} share${n === 1 ? '' : 's'} → charge ${total} sat (state-only; position tracked off-chain)`, spendSats: FEE_TRADE * n, build, effects };
  }

  async buildSell(cfg: MarketConfig, pool: PoolRef, side: Side, shares: bigint): Promise<TxPlan> {
    const n = requireUnits('sell', shares);
    const p = params(cfg);
    const inv = unitInverseMultiplier(p);
    const method = side === 'yes' ? 'sellYes' : 'sellNo';
    const held = side === 'yes' ? pool.state.qYes : pool.state.qNo;
    if (held < BigInt(n) * p.unit) throw new Error(`pool has only ${held / p.unit} ${side.toUpperCase()} outstanding, cannot sell ${n}`);
    let s = stateOf(pool); let collateral = pool.state.collateral; let total = 0n;
    const steps: CallStep[] = [];
    for (let i = 0; i < n; i++) {
      const next = applyUnitSell(s, side, inv, p);
      const proceeds = sellPayoutApproxSats(next, side, p.unit, p);
      collateral -= proceeds; total += proceeds;
      steps.push({ method, args: [intArg(BigInt(pool.satoshis))], newState: strState({ eYes: next.eYes, eNo: next.eNo, qYes: next.qYes, qNo: next.qNo, collateral, resolved: 0n, winner: 0n }) });
      s = next;
    }
    const effects: TxEffects = {
      pool: poolEffect(pool.satoshis, s, collateral, 0, 0),
      spendsPrevPool: true,
      trade: { side, action: 'sell', shares: (shares * WAD).toString(), costSats: Number(total) },
      marketState: 'trading',
    };
    const build: CallBuild = { pool: descriptor(pool), steps };
    return { kind: 'sell', summary: `sell ${n} ${side.toUpperCase()} share${n === 1 ? '' : 's'} → proceeds ${total} sat (state-only)`, spendSats: FEE_TRADE * n, build, effects };
  }

  async buildResolve(cfg: MarketConfig, pool: PoolRef, outcome: Side): Promise<TxPlan> {
    const outcomeN = outcome === 'yes' ? 1n : 0n;
    const { sig, padding } = rabinSign(oracleMsgBytes(outcomeN), RABIN_TEST_KEY);
    const newState: PoolState = { ...pool.state, resolved: 1n, winner: outcomeN };
    const steps: CallStep[] = [{
      method: 'resolve',
      args: [intArg(sig), { t: 'hex', v: leHex(padding) }, intArg(outcomeN), intArg(BigInt(pool.satoshis))],
      newState: strState(newState),
    }];
    const effects: TxEffects = {
      pool: poolEffect(pool.satoshis, stateOf(pool), pool.state.collateral, 1, outcomeN === 1n ? 1 : 0),
      spendsPrevPool: true,
      marketState: 'resolved',
      resolution: outcome,
    };
    const build: CallBuild = { pool: descriptor(pool), steps };
    return { kind: 'resolve', summary: `resolve market ${outcome.toUpperCase()} (mock-oracle Rabin sig, verified on-chain)`, spendSats: FEE_TRADE, build, effects };
  }

  async buildRedeem(_cfg: MarketConfig, _pool: PoolRef, _side: Side, _shares: bigint): Promise<TxPlan> {
    throw new EngineLimitation('redeem', 'winner payout uses addRawOutput + a multi-input token burn the SDK cannot build (BUG-005) — unblocked by Phase 2 (sCrypt). The full mint→resolve→redeem lifecycle is VM-proven.');
  }

  async authorizeAndBroadcast(plan: TxPlan): Promise<BroadcastResult> {
    const wif = fundingWif(); // loaded ONLY here — never returned, logged, or persisted
    if (plan.kind === 'deploy') return this.execDeploy(plan.build as DeployBuild, wif);
    return this.execChain(plan.build as CallBuild, wif);
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

  /**
   * Build + broadcast the N-step call chain. Step 1 spends the confirmed pool + confirmed funding; each later
   * step spends the previous tx's pool output (0-conf) + its change output (0-conf), fed to the SDK via a
   * ChainingProvider overlay so prepareCall selects the right (unconfirmed) funding instead of the spent one.
   * Single-step calls (sell/resolve/1-share buy) use the base provider exactly like the proven path.
   */
  private async execChain(b: CallBuild, wif: string): Promise<BroadcastResult> {
    const base = this.provider();
    const priv = PrivateKey.fromWif(wif);
    const fundingLock = new P2PKH().lock(priv.toAddress());
    const artifact = compileMarket();
    const overlay = new ChainingProvider(base, priv.toAddress(), fundingLock.toHex());

    let pool = { txid: b.pool.txid, vout: b.pool.vout, satoshis: b.pool.satoshis, script: b.pool.lockingScript };
    let last: Transaction | undefined;
    for (let step = 0; step < b.steps.length; step++) {
      const s = b.steps[step]!;
      const provider = step === 0 ? base : overlay; // step 0 uses only confirmed UTXOs
      const contract = RunarContract.fromUtxo(artifact, { txid: pool.txid, outputIndex: pool.vout, satoshis: pool.satoshis, script: pool.script });
      contract.connect(provider as unknown as WhatsOnChainProvider, new BsvSigner(wif));
      const args = s.args.map((a) => (a.t === 'int' ? BigInt(a.v) : a.v));
      const newState = bnState(s.newState) as unknown as Record<string, unknown>;
      const prepared = await contract.prepareCall(s.method, args, { newState, satoshis: pool.satoshis });
      const tx = prepared.tx;

      // Re-sign funding inputs (index ≥ 1) with @bsv/sdk over the FINAL tx (BUG-001 workaround). The contract
      // input's OP_PUSH_TX sig commits to the outputs, which don't change, so it stays valid.
      const utxos = await provider.getUtxos(priv.toAddress());
      const byOutpoint = new Map(utxos.map((u) => [`${u.txid}:${u.outputIndex}`, u]));
      for (let i = 1; i < tx.inputs.length; i++) {
        const inp = tx.inputs[i]!;
        const u = byOutpoint.get(`${inp.sourceTXID}:${inp.sourceOutputIndex}`);
        if (!u) throw new Error(`funding utxo not found for input ${i} (${inp.sourceTXID}:${inp.sourceOutputIndex})`);
        inp.unlockingScript = await new P2PKH().unlock(priv, 'all', false, u.satoshis, fundingLock).sign(tx, i);
      }
      await base.broadcast(tx);       // always broadcast through the real network
      overlay.register(tx);           // expose this tx's pool + change outputs to the next step (0-conf)
      last = tx;
      pool = { txid: tx.id('hex'), vout: 0, satoshis: pool.satoshis, script: tx.outputs[0]!.lockingScript!.toHex() };
    }
    if (!last) throw new Error('call had no steps');
    return { txid: last.id('hex'), poolLockingScript: last.outputs[0]!.lockingScript!.toHex() };
  }
}

const intArg = (v: bigint): ArgSpec => ({ t: 'int', v: v.toString() });

function requireUnits(kind: 'buy' | 'sell', shares: bigint): number {
  if (shares < 1n) throw new Error(`${kind}: shares must be ≥ 1`);
  if (shares > BigInt(MAX_UNITS)) throw new EngineLimitation(kind, `chain length capped at ${MAX_UNITS} unit-txs (single-UTXO 0-conf chaining, BUG-003) — batch larger sizes across calls, or use Phase 2 (sCrypt).`);
  return Number(shares);
}
