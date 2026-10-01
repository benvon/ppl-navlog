import { describe, expect, it } from "vitest";
import { aircraftProfile } from "../services/storage/__tests__/fixtures";
import { validateNavlogFuelInputs } from "./worksheet-input-validation";

const inputs = { fuelAboardGallons: 20, taxiRunupFuelGallons: 1, reserveFuelGallons: 3 };

describe("worksheet fuel input boundary", () => {
  it("accepts zero and exact capacity without requiring enough fuel for the route", () => {
    expect(validateNavlogFuelInputs({ ...inputs, fuelAboardGallons: 0 }, aircraftProfile()).ok).toBe(true);
    expect(validateNavlogFuelInputs({ ...inputs, fuelAboardGallons: 24 }, aircraftProfile()).ok).toBe(true);
    expect(validateNavlogFuelInputs({ ...inputs, fuelAboardGallons: 30 }, { ...aircraftProfile(), usableFuelGallons: undefined }).ok).toBe(true);
  });
  it.each([
    { ...inputs, fuelAboardGallons: undefined }, { ...inputs, fuelAboardGallons: -1 },
    { ...inputs, fuelAboardGallons: Number.NaN }, { ...inputs, fuelAboardGallons: Infinity },
    { ...inputs, fuelAboardGallons: 25 }, { ...inputs, taxiRunupFuelGallons: -1 },
    { ...inputs, reserveFuelGallons: Infinity },
  ])("rejects invalid fuel inputs before calculation: %j", (value) => {
    expect(validateNavlogFuelInputs(value, aircraftProfile()).ok).toBe(false);
  });
});
