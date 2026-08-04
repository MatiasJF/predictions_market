import { bsv, TestWallet, DummyProvider } from 'scrypt-ts'

/** An ephemeral in-memory test signer over a DummyProvider — no key is ever persisted (Golden Rule 6).
 *  NETWORK=local runs entirely offline; DummyProvider fabricates UTXOs. Green off-chain ⇒ valid on-chain. */
export function localSigner(): TestWallet {
    return new TestWallet(
        bsv.PrivateKey.fromRandom(bsv.Networks.testnet),
        new DummyProvider()
    )
}
