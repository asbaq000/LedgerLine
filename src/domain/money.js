/**
 * Money is ALWAYS integer cents. Never floats.
 *
 * Metered rates are stored as "microcents" (cents * 1e6) so a rate like
 * $0.0001 per API call (0.01 cents) is representable exactly as 10000 microcents.
 */

export const MICROCENTS_PER_CENT = 1_000_000;

/**
 * (a * b) / c with exact integer arithmetic and half-away-from-zero rounding.
 *
 * Uses BigInt internally: `units * rateMicrocents` can exceed Number.MAX_SAFE_INTEGER
 * for high-volume metered plans (1e9 calls * 1e6 microcents = 1e15, and that is only
 * one order of magnitude from the 2^53 cliff). Doing it in BigInt removes the class
 * of bug entirely rather than relying on inputs staying small.
 *
 * Rounding: half away from zero. Chosen so that a credit of -X.5 and a charge of
 * +X.5 round to equal magnitudes, which keeps credit/charge pairs symmetric.
 */
export function mulDivRound(a, b, c) {
  const A = toBig(a, 'a');
  const B = toBig(b, 'b');
  const C = toBig(c, 'c');
  if (C === 0n) throw new RangeError('mulDivRound: division by zero');

  const num = A * B;
  const negative = num < 0n !== C < 0n;
  const absNum = num < 0n ? -num : num;
  const absDen = C < 0n ? -C : C;

  const quotient = absNum / absDen;
  const remainder = absNum % absDen;
  // remainder/absDen >= 0.5  <=>  remainder*2 >= absDen
  const rounded = remainder * 2n >= absDen ? quotient + 1n : quotient;

  const result = negative ? -rounded : rounded;
  if (result > 9007199254740991n || result < -9007199254740991n) {
    throw new RangeError(`mulDivRound: result ${result} exceeds safe integer range`);
  }
  return Number(result);
}

function toBig(v, name) {
  if (typeof v === 'bigint') return v;
  if (!Number.isInteger(v)) {
    throw new TypeError(`mulDivRound: ${name} must be an integer, got ${v}`);
  }
  return BigInt(v);
}

/** Sum a list of integer cent amounts, asserting each is an integer. */
export function sumCents(amounts) {
  let total = 0;
  for (const a of amounts) {
    if (!Number.isInteger(a)) throw new TypeError(`sumCents: non-integer amount ${a}`);
    total += a;
  }
  return total;
}

/** 2900 -> "$29.00". Negative: -1933 -> "-$19.33". */
export function formatCents(cents, currency = 'USD') {
  if (!Number.isInteger(cents)) throw new TypeError(`formatCents: non-integer ${cents}`);
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${symbol}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** "29.00" | 29 | "$29" -> 2900. For config/seed input only, never for arithmetic. */
export function dollarsToCents(input) {
  const s = String(input).replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) {
    throw new TypeError(`dollarsToCents: cannot parse ${JSON.stringify(input)}`);
  }
  const negative = s.startsWith('-');
  const [whole, frac = ''] = s.replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return negative ? -cents : cents;
}
