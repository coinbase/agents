import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  UNIT,
  divRound,
  formatAmount,
  formatRatio,
  formatUnits,
  isMultiple,
  parseInputDecimal,
  parseStoredDecimal,
  placesOf,
  toIncrement,
} from './decimal.ts';
import { PaperError } from './types.ts';

const u = (text: string) => parseStoredDecimal(text, 'x', { allowNegative: true });
const code = (expected: string) => (error: unknown) => error instanceof PaperError && error.code === expected;

describe('parseInputDecimal', () => {
  it('scales bounded plain decimals to 18-place units', () => {
    assert.equal(parseInputDecimal('1', 'x'), UNIT);
    assert.equal(parseInputDecimal('0.000000000000000001', 'x'), 1n);
    assert.equal(parseInputDecimal('999999999999999.999999999999999999', 'x'), 10n ** 33n - 1n);
    assert.equal(parseInputDecimal('0', 'x', true), 0n);
  });

  it('rejects non-strings, signs, exponents, padding, overflow and zero', () => {
    for (const value of [1, 1n, null, undefined, '', '-1', '+1', '1e3', '01', '.5', '1.', ' 1', '1,0', '1000000000000000', '0.0000000000000000001', 'NaN', 'Infinity', '0x10']) {
      assert.throws(() => parseInputDecimal(value, 'x'), code('INVALID_DECIMAL'), String(value));
    }
    assert.throws(() => parseInputDecimal('0', 'x'), code('INVALID_DECIMAL'));
    assert.throws(() => parseInputDecimal('0.000', 'x'), code('INVALID_DECIMAL'));
  });
});

describe('parseStoredDecimal', () => {
  it('accepts large stored values and negative only when allowed', () => {
    assert.equal(parseStoredDecimal('12345678901234567890.5', 'x'), 123456789012345678905n * 10n ** 17n);
    assert.equal(parseStoredDecimal('-4.17', 'x', { allowNegative: true }), -417n * 10n ** 16n);
    assert.throws(() => parseStoredDecimal('-4.17', 'x'), code('STATE_INVALID'));
  });

  it('rejects negative zero, malformed values and zero when disallowed', () => {
    for (const value of ['-0', '-0.00', '1e2', 'abc', 5, null]) {
      assert.throws(() => parseStoredDecimal(value, 'x', { allowNegative: true }), code('STATE_INVALID'), String(value));
    }
    assert.throws(() => parseStoredDecimal('0', 'x', { allowZero: false }), code('STATE_INVALID'));
    assert.equal(parseStoredDecimal('0', 'x'), 0n);
  });
});

describe('divRound', () => {
  it('rounds floor, ceil and half-even exactly, including negatives', () => {
    assert.equal(divRound(7n, 2n, 'floor'), 3n);
    assert.equal(divRound(7n, 2n, 'ceil'), 4n);
    assert.equal(divRound(7n, 2n, 'half_even'), 4n);
    assert.equal(divRound(5n, 2n, 'half_even'), 2n);
    assert.equal(divRound(-7n, 2n, 'floor'), -4n);
    assert.equal(divRound(-7n, 2n, 'ceil'), -3n);
    assert.equal(divRound(-5n, 2n, 'half_even'), -2n);
    assert.equal(divRound(-7n, 2n, 'half_even'), -4n);
    assert.equal(divRound(6n, 2n, 'ceil'), 3n);
    assert.equal(divRound(10n, 3n, 'half_even'), 3n);
  });

  it('rejects a non-positive denominator', () => {
    assert.throws(() => divRound(1n, 0n, 'floor'), RangeError);
    assert.throws(() => divRound(1n, -1n, 'floor'), RangeError);
  });
});

describe('toIncrement', () => {
  it('rounds an exact product once, not its parts', () => {
    // 0.333333333333333333 x 3 = 0.999999999999999999 exactly.
    const raw = u('0.333333333333333333') * u('3');
    assert.equal(formatUnits(toIncrement(raw, UNIT, u('0.01'), 'ceil')), '1');
    assert.equal(formatUnits(toIncrement(raw, UNIT, u('0.01'), 'floor')), '0.99');
  });

  it('keeps exact multiples unchanged and checks multiples', () => {
    assert.equal(toIncrement(u('1.23') * UNIT, UNIT, u('0.01'), 'ceil'), u('1.23'));
    assert.equal(isMultiple(u('1.23'), u('0.01')), true);
    assert.equal(isMultiple(u('1.234'), u('0.01')), false);
  });
});

describe('formatting', () => {
  it('pads exact values to increment precision', () => {
    assert.equal(formatAmount(u('1000'), u('0.01')), '1000.00');
    assert.equal(formatAmount(u('-5'), u('0.01')), '-5.00');
    assert.equal(formatAmount(u('0.0123'), u('0.00000001')), '0.01230000');
    assert.equal(formatAmount(0n, u('0.01')), '0.00');
  });

  it('handles zero-scale increments without a trailing dot', () => {
    assert.equal(formatAmount(u('99'), u('1')), '99');
    assert.equal(formatAmount(u('120'), u('10')), '120');
    assert.equal(formatAmount(0n, u('1')), '0');
    assert.equal(formatAmount(u('1.5'), u('1')), '1.5');
  });

  it('shows more precise values canonically and never pads rounded ratios', () => {
    assert.equal(formatAmount(u('1.005'), u('0.01')), '1.005');
    assert.equal(formatUnits(u('100.500')), '100.5');
    assert.equal(formatRatio(100n * UNIT, 3n), '33.333333333333333333');
    assert.equal(formatRatio(100n * UNIT, 2n, u('0.01')), '50.00');
    assert.equal(formatRatio(2n * UNIT - 1n, 1n * UNIT, u('0.01')), '0.000000000000000002');
    assert.equal(formatRatio(1n, 2n), '0');
    assert.equal(formatRatio(3n, 2n), '0.000000000000000002');
  });

  it('counts significant places', () => {
    assert.equal(placesOf(u('0.010')), 2);
    assert.equal(placesOf(u('10')), 0);
    assert.equal(placesOf(1n), 18);
  });
});
