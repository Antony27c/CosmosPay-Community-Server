import { BadRequestException } from '@nestjs/common';
import { fromStroops, toStroops } from '../swaps/swap-math';

/**
 * Minimal shape of a Horizon account balance entry. `asset_type: 'native'` for
 * XLM; issued assets carry `asset_code` + `asset_issuer`. Amounts are decimal
 * strings — convert with {@link toStroops} before comparing.
 */
export interface HorizonBalance {
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  liquidity_pool_id?: string;
  balance?: string;
}

/** Asset identity used by pre-flight checks (code/issuer only). */
export interface PreflightAsset {
  code: string;
  issuer: string | null;
}

export function isNativeAsset(asset: PreflightAsset): boolean {
  return asset.code === 'native' || !asset.issuer;
}

export function hasTrustline(
  balances: HorizonBalance[],
  asset: PreflightAsset,
): boolean {
  if (isNativeAsset(asset)) return true;
  return balances.some(
    (b) => b.asset_code === asset.code && b.asset_issuer === asset.issuer,
  );
}

/**
 * Native XLM needs no trustline. Issued assets must already be trusted, or the
 * on-chain op fails with `op_src_no_trust` / `op_no_trust`. Fail here with a
 * 400 that names the account and `CODE:ISSUER`.
 */
export function assertTrustline(
  balances: HorizonBalance[],
  asset: PreflightAsset,
  address: string,
  detail = 'it must trust the asset before using it',
): void {
  if (isNativeAsset(asset)) return;
  if (!hasTrustline(balances, asset)) {
    throw new BadRequestException(
      `Account ${address} has no trustline for ${asset.code}:${asset.issuer} — ` +
        detail,
    );
  }
}

/**
 * Asserts the source can afford an operation before we build the XDR: each
 * issued asset's trustline balance must cover its required amount, and the
 * native (XLM) balance must cover any native requirement plus the minimum
 * reserve (including a pending pool-share trustline) and the transaction fee.
 * Turns an otherwise on-chain `op_underfunded` / `tx_insufficient_balance`
 * into a clear 400.
 */
export function assertCanAfford(
  account: { subentry_count?: number },
  balances: HorizonBalance[],
  sides: { asset: PreflightAsset; required: bigint }[],
  addingTrustline: boolean,
  txFeeStroops: bigint,
): void {
  // Native side: its own requirement + reserve (0.5 XLM per subentry, +1 for a
  // pending trustline) + the tx fee must all fit within the XLM balance.
  const nativeReq = sides.find((s) => isNativeAsset(s.asset))?.required ?? 0n;
  const nativeBal = toStroops(
    balances.find((b) => b.asset_type === 'native')?.balance ?? '0',
  );
  const subentries =
    BigInt(account.subentry_count ?? 0) + (addingTrustline ? 1n : 0n);
  const reserve = (2n + subentries) * 5_000_000n; // 0.5 XLM base reserve/entry
  if (nativeBal - reserve - txFeeStroops < nativeReq) {
    throw new BadRequestException(
      `Insufficient XLM balance: need ${fromStroops(nativeReq)} plus ` +
        `~${fromStroops(reserve + txFeeStroops)} XLM reserve + network fee, ` +
        `but the account holds ${fromStroops(nativeBal)} XLM`,
    );
  }
  // Issued assets: the trustline balance must cover the required amount.
  for (const s of sides) {
    if (isNativeAsset(s.asset)) continue;
    const bal = toStroops(
      balances.find(
        (b) =>
          b.asset_code === s.asset.code && b.asset_issuer === s.asset.issuer,
      )?.balance ?? '0',
    );
    if (bal < s.required) {
      throw new BadRequestException(
        `Insufficient ${s.asset.code} balance: need ${fromStroops(s.required)}, ` +
          `but the account holds ${fromStroops(bal)}`,
      );
    }
  }
}
