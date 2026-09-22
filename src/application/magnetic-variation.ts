import { trace, type CalculationTrace } from "../domain/calculation-trace";
import type { Coordinate } from "../domain/coordinates";
import type { PlanningValue } from "../domain/planning-value";
import { signedDegrees, type SignedDegrees } from "../domain/units";
import {
  type MagneticModelInput,
  type MagneticVariation,
  calculateWmm2025Variation,
} from "../services/magnetic/wmm2025";

export interface MagneticVariationCalculator {
  calculate(input: MagneticModelInput): MagneticVariation;
}

export const wmm2025MagneticVariationCalculator: MagneticVariationCalculator = {
  calculate: calculateWmm2025Variation,
};

export interface CalculatedMagneticVariation {
  readonly variation: PlanningValue<SignedDegrees>;
  readonly modelResult: MagneticVariation;
  readonly trace: CalculationTrace;
}

/**
 * Converts an isolated model result into the planning-value contract used by
 * heading calculations and overrides. East is positive throughout.
 */
export const calculatePlanningMagneticVariation = (
  input: {
    readonly coordinate: Coordinate;
    readonly date: Date;
    readonly altitudeFeetMsl: number;
  },
  calculator: MagneticVariationCalculator = wmm2025MagneticVariationCalculator,
): CalculatedMagneticVariation => {
  const modelResult = calculator.calculate(input);
  const checkedVariation = signedDegrees(modelResult.declinationDegrees);
  if (!checkedVariation.ok) throw new Error("WMM returned a non-finite declination.");
  const provenance = modelResult.provenance;
  const calculationTrace = trace(
    "wmm2025-magnetic-variation",
    [
      { name: "latitude", value: provenance.coordinate.latitude, unit: "degrees" },
      { name: "longitude", value: provenance.coordinate.longitude, unit: "degrees" },
      { name: "altitude", value: provenance.altitudeFeetMsl, unit: "feet-msl" },
      { name: "decimal year", value: provenance.decimalYear, unit: "unitless" },
      { name: "north magnetic intensity", value: modelResult.northIntensityNanoTesla, unit: "unitless" },
      { name: "east magnetic intensity", value: modelResult.eastIntensityNanoTesla, unit: "unitless" },
    ],
    [{ name: "horizontal magnetic intensity", value: modelResult.horizontalIntensityNanoTesla, unit: "unitless" }],
    { name: "east-positive magnetic variation", value: checkedVariation.value, unit: "degrees" },
    "WMM result is unrounded; UI controls display rounding.",
    ["Altitude is MSL treated as WGS84 ellipsoid height without EGM96 correction; NOAA notes this is negligible for declination."],
  );
  return {
    modelResult,
    trace: calculationTrace,
    variation: {
      computedValue: checkedVariation.value,
      effectiveValue: checkedVariation.value,
      origin: "calculated",
      provenance: {
        sourceId: `wmm2025:${provenance.coefficientSha256}`,
        sourceLabel: `${provenance.model} magnetic variation`,
        sourceVersion: `${provenance.model}; epoch ${provenance.epoch}; sha256 ${provenance.coefficientSha256}`,
        recordedAt: provenance.calculationDate,
      },
      explanation: { formulaId: calculationTrace.formulaId, formulaVersion: "wmm2025-reference-port/v1" },
    },
  };
};
