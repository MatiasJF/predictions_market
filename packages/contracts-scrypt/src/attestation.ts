import { int2ByteString, toByteString, type ByteString } from 'scrypt-ts'
import { RabinPubKey, RabinSig } from 'scrypt-ts-lib'
import { Rabin } from 'rabinsig'

// CONC-003b — the sequencer's SETTLEMENT ATTESTATION, Rabin-signed so a Bond contract can verify it on-chain
// (OP_CHECKSIG only verifies tx sigs; RabinVerifier verifies arbitrary messages, like the oracle in resolve()).
// Deterministic mock key (fixed seed, no persisted secret) — SECURITY_LEVEL 6 matches scrypt-ts-lib.
// The signed message is `key ‖ digest`, key = int2ByteString(marketId,4) ‖ int2ByteString(toVersion,4).
// One honest attestation per settlement version; two different-digest attestations for the same key = equivocation.
const rabin = new Rabin(6)
const privKey = rabin.generatePrivKeyFromSeed(Buffer.from('pm-spike-sequencer-attest'))

/** The sequencer's public Rabin modulus — baked into a Bond as `seqRabin`. */
export const seqRabinPubKey: RabinPubKey = BigInt(rabin.privKeyToPubKey(privKey)) as RabinPubKey

/** Canonical settlement key: marketId(4) ‖ toVersion(4), little-endian (matches on-chain int2ByteString). */
export function settlementKey(marketId: number, toVersion: number): ByteString {
    return int2ByteString(BigInt(marketId), 4n) + int2ByteString(BigInt(toVersion), 4n)
}

export interface RabinAttestation {
    key: string // hex — marketId ‖ toVersion
    digest: string // hex — the batch commitment
    msg: string // hex — key ‖ digest (the signed message)
    sig: RabinSig
}

/** Rabin-sign the sequencer's commitment to `(marketId, toVersion) → digest`. */
export function attest(marketId: number, toVersion: number, digest: string): RabinAttestation {
    const key = settlementKey(marketId, toVersion)
    const msg = key + digest
    const s = rabin.sign(msg, privKey)
    return { key, digest, msg, sig: { s: s.signature, padding: toByteString('00'.repeat(s.paddingByteCount)) } }
}

/** Off-chain mirror of the Bond.slash equivocation check: same key, different digest, both validly signed. */
export function isEquivocation(a: RabinAttestation, b: RabinAttestation): boolean {
    return a.key === b.key && a.digest !== b.digest
}
