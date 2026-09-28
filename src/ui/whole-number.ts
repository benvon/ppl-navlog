/** Rounds half values away from zero for symmetric whole-unit display. */
export function wholeNumberDisplay(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? String(Math.sign(value) * Math.round(Math.abs(value)))
    : "—";
}
