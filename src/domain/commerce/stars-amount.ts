/**
 * Exact monetary representation for Telegram Stars / TON amounts.
 * Pure domain module — no Telegram API dependency, no floating point.
 */

export type StarsAsset = "stars" | "ton";

/**
 * Exact monetary amount. No floating point is used as a canonical value.
 *
 * - `units`   — integer component as a decimal string (no precision loss).
 * - `nanos`   — signed fraction component in minimal units (nanostars for
 *               "stars", nanoton for "ton").
 * - `decimal` — exact normalized decimal string (e.g. "5", "5.25", "-2.5").
 * - `asset`   — "stars" or "ton".
 */
export interface NormalizedStarsAmount {
  asset: StarsAsset;
  units: string;
  nanos: number;
  decimal: string;
}

export const MINIMAL_UNITS_PER_WHOLE = 1_000_000_000;

/** Format a signed raw minimal-units bigint into an exact decimal string. */
export function formatMinimalUnitsDecimal(raw: bigint): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const whole = abs / BigInt(MINIMAL_UNITS_PER_WHOLE);
  const fraction = abs % BigInt(MINIMAL_UNITS_PER_WHOLE);

  const fractionStr = fraction.toString().padStart(9, "0").replace(/0+$/, "");
  const decimal = fractionStr.length > 0 ? `${whole.toString()}.${fractionStr}` : whole.toString();
  return negative ? `-${decimal}` : decimal;
}

/**
 * Format integer units + signed nanos into an exact decimal string.
 * E.g. ("5", 250000000) → "5.25"; ("-2", -500000000) → "-2.5".
 */
export function formatStarsDecimal(units: string, nanos: number): string {
  const raw = BigInt(units) * BigInt(MINIMAL_UNITS_PER_WHOLE) + BigInt(nanos);
  return formatMinimalUnitsDecimal(raw);
}

/**
 * Split a signed raw minimal-units bigint into whole units + signed fraction
 * nanos + exact decimal. Handles both positive and negative sign combos.
 */
export function splitMinimalUnits(raw: bigint): {
  units: string;
  nanos: number;
  decimal: string;
} {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const whole = abs / BigInt(MINIMAL_UNITS_PER_WHOLE);
  const fraction = abs % BigInt(MINIMAL_UNITS_PER_WHOLE);

  return {
    units: negative ? `-${whole.toString()}` : whole.toString(),
    nanos: Number(negative ? -fraction : fraction),
    decimal: formatMinimalUnitsDecimal(raw),
  };
}
