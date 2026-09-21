import type { AircraftProfile } from "../domain/aircraft";
import type { PlanDraft, PlanRevision } from "../domain/route";
import { WorkerWindsAdapter } from "../services/weather/winds-adapter";
import type { MetarTransportClient, WindsTransportClient } from "../services/weather/winds-client";
import { calculateAndSavePlan, type CalculatedPlanPersistence, type CalculatedPlanSaveResult } from "./calculated-plan-use-case";
import { createFullNavlogCalculationEngine } from "./full-navlog-engine";
import type { UseCaseClock, UseCaseIds } from "./plan-use-cases";
import { routeDistanceMidpoint } from "./weather-station-reference";
import { createWorkerWindsPlanWeatherResolver } from "./worker-winds-weather-resolver";

export type BrowserPlanCalculator = (draft: PlanDraft, profile: AircraftProfile, parentRevision?: PlanRevision) => Promise<CalculatedPlanSaveResult>;

/** Wires the selected draft, same-origin Worker sources, calculation, and atomic local save. */
export const createBrowserPlanCalculator = (
  persistence: CalculatedPlanPersistence,
  windsClient: WindsTransportClient & MetarTransportClient,
  ids: UseCaseIds,
  clock: UseCaseClock,
): BrowserPlanCalculator => async (draft, profile, parentRevision) => {
  if (draft.weatherSelection === undefined) {
    return { status: "blocked", reason: "forecast-not-selected", message: "Choose a published winds forecast period before calculating the navlog.", warnings: [] };
  }
  const stationSelectionCoordinate = routeDistanceMidpoint(draft.route);
  const dependencies = {
    weather: createWorkerWindsPlanWeatherResolver(new WorkerWindsAdapter(windsClient), {
      stationSelectionCoordinate,
      weatherSnapshotId: ids.next(),
    }, windsClient),
    calculations: createFullNavlogCalculationEngine(),
  };
  return calculateAndSavePlan(persistence, draft, profile, dependencies, ids, clock, parentRevision);
};
