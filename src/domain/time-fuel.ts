import { trace, type CalculationTrace } from "./calculation-trace";
import { failure, propagateFailure, success, type DomainResult } from "./errors";
import { gallons, minutes, type Gallons, type GallonsPerHour, type Knots, type Minutes, type NauticalMiles } from "./units";

export interface EstimatedTimeEnroute {
  readonly duration: Minutes;
  readonly trace: CalculationTrace;
}

export interface FuelQuantity {
  readonly fuel: Gallons;
  readonly trace: CalculationTrace;
}

export const calculateEstimatedTimeEnroute = (
  distance: NauticalMiles,
  groundspeed: Knots,
): DomainResult<EstimatedTimeEnroute> => {
  if (groundspeed <= 0) {
    return failure("NONPOSITIVE_GROUNDSPEED", "Groundspeed must be greater than zero to calculate time enroute.", {
      groundspeed,
    });
  }
  const durationValue = (distance / groundspeed) * 60;
  const duration = minutes(durationValue);
  if (!duration.ok) return propagateFailure(duration);
  return success({
    duration: duration.value,
    trace: trace(
      "estimated-time-enroute",
      [
        { name: "distance", value: distance, unit: "nautical-miles" },
        { name: "groundspeed", value: groundspeed, unit: "knots" },
      ],
      [{ name: "hours enroute", value: durationValue / 60, unit: "unitless" }],
      { name: "estimated time enroute", value: duration.value, unit: "minutes" },
    ),
  });
};

export const calculateFuelForDuration = (
  duration: Minutes,
  fuelFlow: GallonsPerHour,
): DomainResult<FuelQuantity> => {
  const fuelValue = (duration / 60) * fuelFlow;
  const fuel = gallons(fuelValue);
  if (!fuel.ok) return propagateFailure(fuel);
  return success({
    fuel: fuel.value,
    trace: trace(
      "fuel-for-duration",
      [
        { name: "duration", value: duration, unit: "minutes" },
        { name: "fuel flow", value: fuelFlow, unit: "gallons-per-hour" },
      ],
      [{ name: "duration in hours", value: duration / 60, unit: "unitless" }],
      { name: "fuel", value: fuel.value, unit: "gallons" },
    ),
  });
};

export const sumFuel = (quantities: readonly Gallons[]): DomainResult<Gallons> => {
  const total = quantities.reduce((sum, quantity) => sum + quantity, 0);
  return gallons(total);
};
