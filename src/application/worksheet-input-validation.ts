import type { AircraftProfile } from "../domain/aircraft";
import { failure, propagateFailure, success, type DomainResult } from "../domain/errors";
import type { PlanFuelInputs } from "../domain/route";
import { gallons } from "../domain/units";

/** Checks fuel input limits before any worksheet weather request. */
export const validateNavlogFuelInputs = (fuelInputs: PlanFuelInputs, profile: AircraftProfile): DomainResult<true> => {
  if (fuelInputs.fuelAboardGallons === undefined) return failure("OUT_OF_RANGE", "Fuel aboard is required for a fresh calculation.");
  const fuelAboard = gallons(fuelInputs.fuelAboardGallons);
  if (!fuelAboard.ok) return propagateFailure(fuelAboard);
  const taxiRunup = gallons(fuelInputs.taxiRunupFuelGallons);
  if (!taxiRunup.ok) return propagateFailure(taxiRunup);
  const reserve = gallons(fuelInputs.reserveFuelGallons);
  if (!reserve.ok) return propagateFailure(reserve);
  if (profile.usableFuelGallons !== undefined) {
    const capacity = gallons(profile.usableFuelGallons);
    if (!capacity.ok) return propagateFailure(capacity);
    if (fuelAboard.value > capacity.value) return failure("OUT_OF_RANGE", "Fuel aboard exceeds aircraft usable fuel capacity.", { fuelAboard: fuelAboard.value, usableFuel: capacity.value });
  }
  return success(true);
};

