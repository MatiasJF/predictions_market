import { toByteString } from 'scrypt-ts'
import { RabinPubKey, RabinSig } from 'scrypt-ts-lib'
import { Rabin } from 'rabinsig'

// Deterministic mock Rabin oracle (from a fixed seed — no persisted secret). SECURITY_LEVEL 6 matches
// scrypt-ts-lib's RabinVerifier. The contract's resolve() verifies a signature over `marketTag ‖ outcome`.
const rabin = new Rabin(6)
const privKey = rabin.generatePrivKeyFromSeed(Buffer.from('pm-spike-mock-oracle'))

/** The oracle's public modulus — baked into the pool as `oracleN`. */
export const oracleN: RabinPubKey = BigInt(rabin.privKeyToPubKey(privKey)) as RabinPubKey

/** Sign `marketTag ‖ num2bin(outcome,1)` and return the contract's RabinSig shape. */
export function signOutcome(marketTagHex: string, outcome: bigint): RabinSig {
    const msgHex = marketTagHex + (outcome === 1n ? '01' : '00')
    const sig = rabin.sign(msgHex, privKey)
    return {
        s: sig.signature,
        padding: toByteString('00'.repeat(sig.paddingByteCount)),
    }
}
