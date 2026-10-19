import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseDecimalToBigInt, formatBigIntToDecimal } from './decimal.ts';

describe('parseDecimalToBigInt', () => {
  it('parses whole number', () => {
    assert.equal(parseDecimalToBigInt('1', 18), 1000000000000000000n);
  });

  it('parses decimal with full precision (18 decimals)', () => {
    assert.equal(parseDecimalToBigInt('0.001', 18), 1000000000000000n);
    assert.equal(parseDecimalToBigInt('1.000000000000000001', 18), 1000000000000000001n);
  });

  it('parses 9-decimal precision', () => {
    assert.equal(parseDecimalToBigInt('1', 9), 1000000000n);
    assert.equal(parseDecimalToBigInt('0.5', 9), 500000000n);
    assert.equal(parseDecimalToBigInt('0.001', 9), 1000000n);
    assert.equal(parseDecimalToBigInt('1.5', 9), 1500000000n);
  });

  it('rejects excess decimal places', () => {
    assert.throws(() => parseDecimalToBigInt('0.1234567890', 9), /too many decimal places/);
    assert.throws(() => parseDecimalToBigInt('0.0000000000000000001', 18), /too many decimal places/);
  });

  it('accepts exact decimal places', () => {
    assert.equal(parseDecimalToBigInt('0.123456789', 9), 123456789n);
    assert.equal(parseDecimalToBigInt('1.000000000000000001', 18), 1000000000000000001n);
  });

  it('pads short decimal places', () => {
    assert.equal(parseDecimalToBigInt('0.1', 9), 100000000n);
  });

  it('returns 0n for empty string', () => {
    assert.equal(parseDecimalToBigInt('', 18), 0n);
  });

  it('handles missing whole part', () => {
    assert.equal(parseDecimalToBigInt('.5', 9), 500000000n);
  });

  it('handles trailing dot (no fractional part)', () => {
    assert.equal(parseDecimalToBigInt('1.', 18), 1000000000000000000n);
  });

  it('handles zero', () => {
    assert.equal(parseDecimalToBigInt('0', 18), 0n);
    assert.equal(parseDecimalToBigInt('0.0', 9), 0n);
  });

  it('throws on non-numeric input', () => {
    assert.throws(() => parseDecimalToBigInt('abc', 12));
  });
});

describe('formatBigIntToDecimal', () => {
  it('renders whole numbers without a decimal point', () => {
    assert.equal(formatBigIntToDecimal(1000000000000n, 12), '1');
    assert.equal(formatBigIntToDecimal(0n, 12), '0');
  });

  it('trims trailing zeros', () => {
    assert.equal(formatBigIntToDecimal(10000000000n, 12), '0.01');
    assert.equal(formatBigIntToDecimal(1500000000n, 9), '1.5');
  });

  it('pads values smaller than one scale unit', () => {
    assert.equal(formatBigIntToDecimal(1n, 12), '0.000000000001');
    assert.equal(formatBigIntToDecimal(123456789n, 9), '0.123456789');
  });

  it('handles zero decimals', () => {
    assert.equal(formatBigIntToDecimal(42n, 0), '42');
  });

  it('handles negative values', () => {
    assert.equal(formatBigIntToDecimal(-10000000000n, 12), '-0.01');
    assert.equal(formatBigIntToDecimal(-1000000000000n, 12), '-1');
  });

  it('round-trips with parseDecimalToBigInt', () => {
    for (const v of ['0.01', '65000.01', '3200.125', '0.00001234', '1', '0.000000000001']) {
      assert.equal(formatBigIntToDecimal(parseDecimalToBigInt(v, 12), 12), v);
    }
  });

  it('scaled prices exceed float53, so bigint is load-bearing', () => {
    const scaled = parseDecimalToBigInt('86800.010000000001', 12);
    assert.ok(scaled > BigInt(Number.MAX_SAFE_INTEGER));
    assert.notEqual(BigInt(Number(scaled)), scaled);
  });

  it('round-trips parse -> format -> parse', () => {
    for (const v of ['0.01', '86800.010000000001', '0.000000000001', '1', '0']) {
      const scaled = parseDecimalToBigInt(v, 12);
      assert.equal(parseDecimalToBigInt(formatBigIntToDecimal(scaled, 12), 12), scaled);
    }
  });

  it('formats negatives', () => {
    assert.equal(formatBigIntToDecimal(-10000000000n, 12), '-0.01');
    assert.equal(formatBigIntToDecimal(-1000000000000n, 12), '-1');
  });

  it('truncates a divisor coprime to 10, and stays stable afterwards', () => {
    const third = parseDecimalToBigInt('1', 12) / 3n;
    assert.equal(formatBigIntToDecimal(third, 12), '0.333333333333');
    assert.equal(parseDecimalToBigInt(formatBigIntToDecimal(third, 12), 12), third);

    const half = parseDecimalToBigInt('1', 12) / 2n;
    assert.equal(formatBigIntToDecimal(half, 12), '0.5');
  });

  it('rejects malformed decimals instead of silently truncating', () => {
    for (const v of ['1.2.3', '1e5', '--1', '.', '1..2', '1 2', '+1']) {
      assert.throws(() => parseDecimalToBigInt(v, 12), /invalid decimal/, v);
    }
  });

  it('is sign-aware', () => {
    assert.equal(parseDecimalToBigInt('-0.01', 12), -10000000000n);
    assert.equal(parseDecimalToBigInt('-1', 12), -1000000000000n);
    assert.equal(formatBigIntToDecimal(parseDecimalToBigInt('-0.01', 12), 12), '-0.01');
  });
});
