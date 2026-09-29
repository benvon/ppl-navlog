import { describe, expect, it } from "vitest";

import { equalWithinArithmeticRoundoff } from "./arithmetic-roundoff";

describe("equalWithinArithmeticRoundoff", () => {
  it("treats a few floating-point steps as equal but preserves nearby planning distances", () => {
    expect(equalWithinArithmeticRoundoff(12 - Number.EPSILON * 8, 12)).toBe(true);
    expect(equalWithinArithmeticRoundoff(12 - 0.01, 12)).toBe(false);
  });

  it("does not treat invalid numbers as equal", () => {
    expect(equalWithinArithmeticRoundoff(Number.NaN, Number.NaN)).toBe(false);
    expect(equalWithinArithmeticRoundoff(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).toBe(false);
  });
});
