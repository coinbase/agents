const DECIMAL = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;

export function parseDecimalToBigInt(value: string, decimals: number): bigint {
  if (!value) return 0n;
  if (!DECIMAL.test(value)) throw new Error(`invalid decimal: ${value}`);
  const negative = value.startsWith('-');
  const [whole, frac = ''] = (negative ? value.slice(1) : value).split('.');
  if (frac.length > decimals) {
    throw new Error(`too many decimal places (max ${decimals}): ${value}`);
  }
  const scaled = BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
  return negative ? -scaled : scaled;
}

export function formatBigIntToDecimal(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}
