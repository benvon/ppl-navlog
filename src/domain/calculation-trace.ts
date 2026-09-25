export type TraceUnit =
  | "degrees-true"
  | "degrees-magnetic"
  | "degrees-compass"
  | "degrees"
  | "celsius"
  | "knots"
  | "nautical-miles"
  | "feet-msl"
  | "minutes"
  | "gallons"
  | "gallons-per-hour"
  | "unitless";

export interface TraceValue {
  readonly name: string;
  readonly value: number | string | boolean | null;
  readonly unit: TraceUnit;
}

export interface CalculationTrace {
  readonly formulaId: string;
  readonly formulaVersion: string;
  readonly inputs: readonly TraceValue[];
  readonly intermediateValues: readonly TraceValue[];
  readonly result: TraceValue;
  readonly rounding: {
    readonly calculation: "unrounded";
    readonly display: string;
  };
  readonly warnings: readonly string[];
}

export const trace = (
  formulaId: string,
  inputs: readonly TraceValue[],
  intermediateValues: readonly TraceValue[],
  result: TraceValue,
  displayRounding = "UI decides presentation rounding.",
  warnings: readonly string[] = [],
): CalculationTrace => ({
  formulaId,
  formulaVersion: "1.0.0",
  inputs,
  intermediateValues,
  result,
  rounding: { calculation: "unrounded", display: displayRounding },
  warnings,
});
