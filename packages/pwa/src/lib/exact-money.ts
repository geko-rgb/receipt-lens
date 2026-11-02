import type { ExactMoney } from "./entities.js";

export type { ExactMoney } from "./entities.js";

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function make(n: bigint, d: bigint): ExactMoney {
  if (d === 0n) throw new Error("zero denominator");
  if (d < 0n) [n, d] = [-n, -d];
  const g = gcd(n, d);
  if (g > 1n) [n, d] = [n / g, d / g];
  return { numeratorPaise: n.toString(), denominator: d.toString() };
}

const big = (v: string): bigint => BigInt(v);

export function fromPaise(paise: number | bigint): ExactMoney {
  if (typeof paise === "number" && !Number.isInteger(paise)) {
    throw new Error("paise must be an integer");
  }
  return make(BigInt(paise), 1n);
}

export function add(a: ExactMoney, b: ExactMoney): ExactMoney {
  return make(
    big(a.numeratorPaise) * big(b.denominator) + big(b.numeratorPaise) * big(a.denominator),
    big(a.denominator) * big(b.denominator)
  );
}

export function sub(a: ExactMoney, b: ExactMoney): ExactMoney {
  return make(
    big(a.numeratorPaise) * big(b.denominator) - big(b.numeratorPaise) * big(a.denominator),
    big(a.denominator) * big(b.denominator)
  );
}

export function divInt(a: ExactMoney, divisor: number | bigint): ExactMoney {
  const d = BigInt(divisor);
  if (d <= 0n) throw new Error("divisor must be a positive integer");
  return make(big(a.numeratorPaise), big(a.denominator) * d);
}

export function compare(a: ExactMoney, b: ExactMoney): -1 | 0 | 1 {
  const diff =
    big(a.numeratorPaise) * big(b.denominator) - big(b.numeratorPaise) * big(a.denominator);
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
}

export function floorPaise(a: ExactMoney): bigint {
  const n = big(a.numeratorPaise);
  const d = big(a.denominator);
  const q = n / d;
  return n % d !== 0n && (n < 0n !== d < 0n) ? q - 1n : q;
}
