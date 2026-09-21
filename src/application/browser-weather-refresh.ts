import type { PlanRevision, PlanWeatherSelection } from "../domain/route";
import { createFullNavlogCalculationEngine } from "./full-navlog-engine";
import type { UseCaseClock, UseCaseIds } from "./plan-use-cases";
import { routeDistanceMidpoint } from "./weather-station-reference";
import {
  refreshCalculatedPlanWeather,
  type CalculatedWeatherRefreshResult,
  type WeatherRefreshEvidenceReader,
} from "./weather-refresh-use-case";
import type { WeatherRefreshPersistence } from "./weather-refresh";
import { createWorkerWindsPlanWeatherResolver } from "./worker-winds-weather-resolver";
import { WorkerWindsAdapter } from "../services/weather/winds-adapter";
import type { MetarTransportClient, WindsTransportClient } from "../services/weather/winds-client";

export type BrowserWeatherRefresh = (
  parentRevision: PlanRevision,
  weatherSelection: PlanWeatherSelection | undefined,
) => Promise<CalculatedWeatherRefreshResult>;

/** Wires a selected replacement forecast into calculate-first immutable refresh. */
export const createBrowserWeatherRefresh = (
  persistence: WeatherRefreshPersistence & WeatherRefreshEvidenceReader,
  windsClient: WindsTransportClient & MetarTransportClient,
  ids: UseCaseIds,
  clock: UseCaseClock,
): BrowserWeatherRefresh => async (parentRevision, weatherSelection) => {
  const stationSelectionCoordinate = routeDistanceMidpoint(parentRevision.draftSnapshot.route);
  return refreshCalculatedPlanWeather(
    persistence,
    parentRevision,
    weatherSelection,
    {
      weather: createWorkerWindsPlanWeatherResolver(new WorkerWindsAdapter(windsClient), {
        stationSelectionCoordinate,
        weatherSnapshotId: ids.next(),
      }, windsClient),
      calculations: createFullNavlogCalculationEngine(),
    },
    ids,
    clock,
  );
};
