import { describe, expect, it } from "vitest";
import {
  add,
  compare,
  divInt,
  floorPaise,
  fromPaise,
  sub,
  type ExactMoney,
} from "./exact-money.js";

const em = (n: string, d: string): ExactMoney => ({ numeratorPaise: n, denominator: d });

describe("ExactMoney — rational paise arithmetic", () => {
  it("integer paise enter as denominator-1 rationals with string parts", () => {
    expect(fromPaise(16025)).toEqual(em("16025", "1"));
  });

  it("arithmetic is GCD-reduced so no unreduced fraction survives", () => {
    expect(add(divInt(fromPaise(1), 2), divInt(fromPaise(1), 2))).toEqual(em("1", "1"));
    expect(divInt(divInt(fromPaise(6), 2), 3)).toEqual(em("1", "1"));
    expect(sub(fromPaise(4), fromPaise(1))).toEqual(em("3", "1"));
  });

  it("the golden shared-unit division 160.25 paise×100 over three stays exact", () => {
    expect(divInt(fromPaise(16025), 3)).toEqual(em("16025", "3"));
    expect(add(add(divInt(fromPaise(16025), 3), divInt(fromPaise(16025), 3)), divInt(fromPaise(16025), 3))).toEqual(
      fromPaise(16025)
    );
  });

  it("negative amounts keep the sign on the numerator with a positive denominator", () => {
    expect(divInt(fromPaise(-1), 2)).toEqual(em("-1", "2"));
    expect(add(divInt(fromPaise(-1), 3), divInt(fromPaise(-1), 3))).toEqual(em("-2", "3"));
  });

  it("floor and fractional remainder drive the settlement conversion", () => {
    const third = divInt(fromPaise(24635), 3); // 8211.666…
    expect(floorPaise(third)).toBe(8211n);
    expect(add(fromPaise(8211), divInt(fromPaise(2), 3))).toEqual(third);
    expect(compare(divInt(fromPaise(2), 3), divInt(fromPaise(1), 2))).toBe(1);
    expect(compare(fromPaise(-1), fromPaise(0))).toBe(-1);
    expect(compare(fromPaise(5), fromPaise(5))).toBe(0);
  });

  it("JSON round-trip is lossless", () => {
    const value = divInt(fromPaise(72710), 3);
    expect(JSON.parse(JSON.stringify(value))).toEqual(em("72710", "3"));
  });

  it("non-integer paise are rejected at the money boundary", () => {
    expect(() => fromPaise(10.5)).toThrow("paise must be an integer");
  });

  it("both parts of every computed share are plain integer strings — no float ever appears", () => {
    const third = divInt(fromPaise(16025), 3);
    const repeated = add(third, third);
    const json = JSON.stringify(repeated);
    expect(json).not.toMatch(/\.\d/);
    expect(repeated.numeratorPaise).toMatch(/^-?\d+$/);
    expect(repeated.denominator).toMatch(/^\d+$/);
  });
});
