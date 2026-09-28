/** Matches the calculated navlog's whole-unit display while preserving inputs elsewhere. */
export function wholeNumberDisplay(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(Math.round(value)) : "—";
}
