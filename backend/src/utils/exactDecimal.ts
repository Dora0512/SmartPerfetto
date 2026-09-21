// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

/** Exact decimal numbers as rationals; no floating-point rounding. */
export type Rational = {numerator: bigint; denominator: bigint};

/** A finite safe number or a decimal/exponent string, exactly; anything else is undefined. */
export function exactNumber(value: unknown): Rational | undefined {
  if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) {
    return undefined;
  }
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const text = String(value);
  // Bound BigInt allocation even for hostile machine declarations.
  if (text.length > 512) return undefined;
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) return undefined;
  const exponent = Number(match[4] || '0') - (match[3]?.length || 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1024) return undefined;
  const digits = BigInt(`${match[1]}${match[2]}${match[3] || ''}`);
  return exponent >= 0
    ? {numerator: digits * (10n ** BigInt(exponent)), denominator: 1n}
    : {numerator: digits, denominator: 10n ** BigInt(-exponent)};
}

export function compareRationals(left: Rational, right: Rational): number {
  const difference = left.numerator * right.denominator - right.numerator * left.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

/** Exact equality of two numeric representations (number or decimal string). */
export function exactNumbersEqual(left: unknown, right: unknown): boolean {
  const a = exactNumber(left);
  const b = exactNumber(right);
  return a !== undefined && b !== undefined && compareRationals(a, b) === 0;
}
