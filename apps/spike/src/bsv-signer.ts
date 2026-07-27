// A correct runar-sdk Signer that delegates P2PKH signing to @bsv/sdk's battle-tested template.
// Works around BUG-001 (runar-sdk LocalSigner produces a mainnet-rejected signature) — see docs/Runar-bugs.md.
import { PrivateKey, P2PKH, Script, Transaction, Utils } from '@bsv/sdk';
import type { Signer } from 'runar-sdk';

export class BsvSigner implements Signer {
  private readonly priv: PrivateKey;
  constructor(wif: string) {
    this.priv = PrivateKey.fromWif(wif);
  }
  async getPublicKey(): Promise<string> {
    return this.priv.toPublicKey().toDER('hex') as string;
  }
  async getAddress(): Promise<string> {
    return this.priv.toAddress();
  }
  /** Return the DER+sighash signature hex for a P2PKH input (SIGHASH_ALL|FORKID). */
  async sign(txHex: string, inputIndex: number, subscript: string, satoshis: number): Promise<string> {
    const tx = Transaction.fromHex(txHex);
    const template = new P2PKH().unlock(this.priv, 'all', false, satoshis, Script.fromHex(subscript));
    const unlock = await template.sign(tx, inputIndex);
    const sigChunk = unlock.chunks[0]!; // [<sig>, <pubkey>]; runar-sdk wraps the sig with its own pushdata
    return Utils.toHex(sigChunk.data as number[]);
  }
}
