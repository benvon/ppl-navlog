/**
 * Equality for results of floating-point arithmetic. This absorbs only machine
 * roundoff; it is not a tolerance for pilot-entered positions or flight estimates.
 */
export const equalWithinArithmeticRoundoff = (left: number, right: number): boolean => {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  const roundoff = Number.EPSILON * 16 * Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= roundoff;
};
