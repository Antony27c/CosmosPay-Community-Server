import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { StrKey } from '@stellar/stellar-sdk';

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Decodes a Solana-style base58 public key. Returns null when the string is not
 * valid base58 or does not decode to exactly 32 bytes.
 */
function decodeSolanaAddress(value: string): Uint8Array | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }

  let num = 0n;
  for (const char of value) {
    const index = BASE58_ALPHABET.indexOf(char);
    if (index < 0) {
      return null;
    }
    num = num * 58n + BigInt(index);
  }

  const bytes: number[] = [];
  while (num > 0n) {
    bytes.push(Number(num % 256n));
    num = num / 256n;
  }
  bytes.reverse();

  // Preserve leading zero bytes encoded as leading '1' characters in base58.
  for (const char of value) {
    if (char !== '1') {
      break;
    }
    bytes.unshift(0);
  }

  if (bytes.length !== 32) {
    return null;
  }
  return Uint8Array.from(bytes);
}

function isValidForChain(chain: unknown, address: unknown): boolean {
  if (typeof address !== 'string') {
    return false;
  }

  switch (chain) {
    case 'stellar':
      return StrKey.isValidEd25519PublicKey(address);
    case 'solana':
      return decodeSolanaAddress(address) !== null;
    case 'evm':
      return EVM_ADDRESS_RE.test(address);
    default:
      return false;
  }
}

/**
 * Validates that a wallet address matches the `chain` field on the same object:
 * Stellar (G... via StrKey), Solana (base58 → 32 bytes), or EVM (0x + 40 hex).
 */
export function IsWalletAddressForChain(
  chainProperty = 'chain',
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isWalletAddressForChain',
      target: object.constructor,
      propertyName,
      constraints: [chainProperty],
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const [chainProp] = args.constraints as [string];
          const chain = (args.object as Record<string, unknown>)[chainProp];
          return isValidForChain(chain, value);
        },
        defaultMessage(args: ValidationArguments) {
          const [chainProp] = args.constraints as [string];
          const chain = (args.object as Record<string, unknown>)[chainProp];
          if (chain === 'stellar') {
            return `${args.property} must be a valid Stellar account address (G...) for chain stellar`;
          }
          if (chain === 'solana') {
            return `${args.property} must be a valid Solana address (base58, 32 bytes) for chain solana`;
          }
          if (chain === 'evm') {
            return `${args.property} must be a valid EVM address (0x + 40 hex) for chain evm`;
          }
          return `${args.property} must be a valid wallet address for the given chain`;
        },
      },
    });
  };
}
