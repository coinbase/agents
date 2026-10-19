// Fixed-point helpers for the paper simulator. Every amount is a bigint count of
// 10^-18 units; products and quotients stay exact rationals until a single
// explicit rounding step. No floats.
import { formatBigIntToDecimal, parseDecimalToBigInt } from '../lib/decimal.ts';
import { PaperError } from './types.ts';

export const SCALE = 18;
export const UNIT = 10n ** BigInt(SCALE);

// Bounded external input: 15 integer and 18 fraction digits, no sign, no
// exponent, no leading zeros.
const INPUT = /^(0|[1-9][0-9]{0,14})(\.[0-9]{1,18})?$/;
// Persisted state may exceed the input bound after sells (price x size).
const STORED = /^-?(0|[1-9][0-9]{0,39})(\.[0-9]{1,18})?$/;

export type Rounding = 'floor' | 'ceil' | 'half_even';

export function parseInputDecimal(value: unknown, field: string, allowZero = false): bigint {
  if (typeof value !== 'string' || !INPUT.test(value)) {
    throw new PaperError(
      'INVALID_DECIMAL',
      `${field} must be a plain decimal string (max 15 integer and 18 fraction digits)`,
      'Pass the amount as a decimal string such as "0.01"; no sign, exponent or leading zeros.',
    );
  }
  const units = parseDecimalToBigInt(value, SCALE);
  if (units === 0n && !allowZero) {
    throw new PaperError('INVALID_DECIMAL', `${field} must be positive`, 'Pass an amount greater than zero.');
  }
  return units;
}

export function parseStoredDecimal(
  value: unknown,
  field: string,
  options: { allowNegative?: boolean; allowZero?: boolean } = {},
): bigint {
  if (typeof value !== 'string' || !STORED.test(value)) {
    throw stateError(`${field} is not a decimal string`);
  }
  const units = parseDecimalToBigInt(value, SCALE);
  if (units === 0n && value.startsWith('-')) throw stateError(`${field} is not a decimal string`);
  if (units < 0n && !options.allowNegative) throw stateError(`${field} must not be negative`);
  if (units === 0n && options.allowZero === false) throw stateError(`${field} must be positive`);
  return units;
}

function stateError(message: string): PaperError {
  return new PaperError(
    'STATE_INVALID',
    `paper state ${message}`,
    'Stop and run coinbase-paper doctor; do not reinitialize or edit the account.',
  );
}

/** Rounds num/den to an integer. den must be positive. */
export function divRound(num: bigint, den: bigint, mode: Rounding): bigint {
  if (den <= 0n) throw new RangeError('divRound requires a positive denominator');
  let q = num / den;
  let r = num % den;
  if (r === 0n) return q;
  if (r < 0n) {
    q -= 1n;
    r += den;
  }
  if (mode === 'floor') return q;
  if (mode === 'ceil') return q + 1n;
  const twice = 2n * r;
  return twice > den || (twice === den && (q & 1n) === 1n) ? q + 1n : q;
}

/** Rounds the rational num/den (in units) to a multiple of increment (in units). */
export function toIncrement(num: bigint, den: bigint, increment: bigint, mode: Rounding): bigint {
  return divRound(num, den * increment, mode) * increment;
}

export function isMultiple(units: bigint, increment: bigint): boolean {
  return units % increment === 0n;
}

/** Significant fraction digits of a units value. */
export function placesOf(units: bigint): number {
  const text = formatUnits(units);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

/** Canonical decimal string: no trailing zeros, "0" for zero. */
export function formatUnits(units: bigint, minPlaces = 0): string {
  const text = formatBigIntToDecimal(units, SCALE);
  if (minPlaces === 0) return text;
  const dot = text.indexOf('.');
  const frac = dot < 0 ? '' : text.slice(dot + 1);
  if (frac.length >= minPlaces) return text;
  const whole = dot < 0 ? text : text.slice(0, dot);
  return `${whole}.${frac.padEnd(minPlaces, '0')}`;
}

/**
 * Display format: an exact value is padded to the increment's precision when it
 * has no more digits than the increment; otherwise it is shown canonically.
 * `exact` is false when the value was already rounded from a longer rational.
 */
export function formatAmount(units: bigint, increment?: bigint | null, exact = true): string {
  if (increment != null && exact) {
    const shown = placesOf(increment);
    if (placesOf(units) <= shown) return formatUnits(units, shown);
  }
  return formatUnits(units);
}

/** Formats the rational num/den (in units) at 18 places, half-even. */
export function formatRatio(num: bigint, den: bigint, increment?: bigint | null): string {
  return formatAmount(divRound(num, den, 'half_even'), increment, num % den === 0n);
}
