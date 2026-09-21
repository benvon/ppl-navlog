import type { WindsAloftLevel, WindsForecastAvailability, WindsForecastSuccessPayload, WindsSourceProvenance, WindsStationsSuccessPayload } from "../../../worker/api/contracts";
import { coordinate, sameCoordinate, type Coordinate } from "../../domain/coordinates";
import { failure, propagateFailure, type DomainResult } from "../../domain/errors";
import type { EffectiveWindResolver } from "../../domain/phase-planning";
import { feetMsl } from "../../domain/units";
import { windAtAltitude, type Wind, type WindAtAltitude } from "../../domain/wind";
import { resolveWindAtAltitude, type AltitudeResolvedWind } from "../../domain/weather-altitude";
import { sampleEffectivePhaseWind, type EffectivePhaseWind, type EffectiveWindSamplingOptions } from "../../domain/weather-effective-wind";
import { selectNearestWindsStation, type AvailableWindsStation, type NearestWindsStationSelection } from "../../domain/weather-stations";
import { selectForecastValidTime, type AvailableForecastValidPeriod, type ForecastValidTimeSelection } from "../../domain/weather-valid-time";
import type { WindsTransportClient } from "./winds-client";

export interface WorkerWindsSelectionInput {
  /** One through 100 route coordinates forwarded to Worker station discovery. */
  readonly routeCoordinates: readonly Coordinate[];
  /** Explicit documented representative coordinate used for nearest-station selection. */
  readonly stationSelectionCoordinate: Coordinate;
  /** A published Worker forecast `validAt` timestamp selected by the pilot. */
  readonly selectedForecastValidTimeUtc: string;
  readonly departureTimeUtc: string;
}

export interface WindLevelEvidence {
  readonly transport: WindsAloftLevel;
  readonly domainLevel?: WindAtAltitude;
  readonly directionTreatment: "published-direction" | "calm-normalized-to-000" | "unavailable";
}

export interface LoadedWindsData {
  readonly stationSelection: NearestWindsStationSelection;
  readonly forecastSelection: ForecastValidTimeSelection;
  readonly forecastPayload: WindsForecastSuccessPayload;
  readonly stationDiscoveryPayload: WindsStationsSuccessPayload;
  readonly availableLevels: readonly WindAtAltitude[];
  readonly levelEvidence: readonly WindLevelEvidence[];
  /** Raw, typed transport records suitable for an immutable weather snapshot. */
  readonly provenance: {
    readonly discovery: readonly WindsSourceProvenance[];
    readonly forecast: WindsSourceProvenance;
    readonly requestIds: { readonly stationDiscovery: string; readonly forecast: string };
  };
}

export class WindsAdapterError extends Error {
  public constructor(readonly code: "TRANSPORT" | "SELECTION" | "INVALID_FORECAST" | "NO_USABLE_LEVELS", message: string) {
    super(message);
    this.name = "WindsAdapterError";
  }
}

const toAvailableStation = (source: { readonly id: string; readonly coordinates: { readonly latitudeDeg: number; readonly longitudeDeg: number }; readonly name: string | null }): DomainResult<AvailableWindsStation> => {
  const location = coordinate(source.coordinates.latitudeDeg, source.coordinates.longitudeDeg);
  return location.ok
    ? { ok: true, value: { id: source.id, coordinate: location.value, name: source.name ?? undefined } }
    : propagateFailure(location);
};

const forecastPeriods = (payload: WindsStationsSuccessPayload): readonly AvailableForecastValidPeriod[] =>
  payload.forecasts.map((forecast) => ({
    // Worker forecast lookup is keyed by the canonical validAt instant.
    id: forecast.validAt,
    validFromUtc: forecast.useFrom,
    validToUtc: forecast.useUntil,
  }));

const requireDomainValue = <T>(result: DomainResult<T>): T => {
  if (!result.ok) throw new WindsAdapterError("SELECTION", result.error.message);
  return result.value;
};

const requireCoordinateMatch = (expected: Coordinate, actual: { readonly latitudeDeg: number; readonly longitudeDeg: number }): void => {
  const converted = coordinate(actual.latitudeDeg, actual.longitudeDeg);
  if (!converted.ok) throw new WindsAdapterError("INVALID_FORECAST", "Forecast station coordinate was invalid after transport validation.");
  if (!sameCoordinate(expected, converted.value)) {
    throw new WindsAdapterError("INVALID_FORECAST", "Forecast station identity changed between station discovery and forecast retrieval.");
  }
};

const validateForecastIdentity = (
  stationSelection: NearestWindsStationSelection,
  forecastSelection: ForecastValidTimeSelection,
  discoveryAvailability: WindsForecastAvailability,
  payload: WindsForecastSuccessPayload,
): void => {
  const { forecast } = payload;
  if (forecast.station.id !== stationSelection.station.id || forecast.station.region !== payload.provenance.region) {
    throw new WindsAdapterError("INVALID_FORECAST", "Forecast station identity or region did not match the selected station.");
  }
  if (forecast.validAt !== forecastSelection.period.id) {
    throw new WindsAdapterError("INVALID_FORECAST", "Forecast valid time did not match the explicit selected period.");
  }
  if (
    forecast.forecastCycle !== discoveryAvailability.forecastCycle ||
    forecast.issuedAt !== discoveryAvailability.issuedAt ||
    forecast.useFrom !== discoveryAvailability.useFrom ||
    forecast.useUntil !== discoveryAvailability.useUntil
  ) {
    throw new WindsAdapterError("INVALID_FORECAST", "Forecast cycle or use window changed between discovery and forecast retrieval.");
  }
  if (!forecast.station.availableForecastCycles.includes(forecast.forecastCycle)) {
    throw new WindsAdapterError("INVALID_FORECAST", "Forecast station did not advertise the returned forecast cycle.");
  }
  requireCoordinateMatch(stationSelection.station.coordinate, forecast.station.coordinates);
};

const requireUniqueDiscoveryAvailability = (
  discovery: WindsStationsSuccessPayload,
  selectedValidTimeUtc: string,
): WindsForecastAvailability => {
  const matches = discovery.forecasts.filter((forecast) => forecast.validAt === selectedValidTimeUtc);
  if (matches.length !== 1) {
    throw new WindsAdapterError("SELECTION", "Selected forecast valid time is unavailable or ambiguous in station discovery.");
  }
  const selected = matches[0];
  if (selected === undefined) {
    throw new WindsAdapterError("SELECTION", "Selected forecast valid time is unavailable or ambiguous in station discovery.");
  }
  return selected;
};

const normalizeLevel = (source: WindsAloftLevel): DomainResult<WindLevelEvidence> => {
  if (source.availability === "unavailable") {
    return { ok: true, value: { transport: source, directionTreatment: "unavailable" } };
  }
  if (source.windSpeedKt === null) {
    return failure("UNSUPPORTED_WIND_ALTITUDE", "An available winds-aloft level must include wind speed.", { altitudeFt: source.altitudeFt });
  }
  const direction = source.windFromDegTrue ?? 0;
  if (source.windFromDegTrue === null && source.windSpeedKt !== 0) {
    return failure("UNSUPPORTED_WIND_ALTITUDE", "Only a calm winds-aloft level may omit direction.", { altitudeFt: source.altitudeFt });
  }
  const level = windAtAltitude(source.altitudeFt, direction, source.windSpeedKt);
  if (!level.ok) return propagateFailure(level);
  return {
    ok: true,
    value: {
      transport: source,
      domainLevel: level.value,
      directionTreatment: source.windFromDegTrue === null ? "calm-normalized-to-000" : "published-direction",
    },
  };
};

const normalizeLevels = (levels: readonly WindsAloftLevel[]): readonly WindLevelEvidence[] => {
  const normalized: WindLevelEvidence[] = [];
  for (const level of levels) {
    const result = normalizeLevel(level);
    if (!result.ok) throw new WindsAdapterError("INVALID_FORECAST", result.error.message);
    normalized.push(result.value);
  }
  return normalized;
};

/**
 * Browser-side composition over the Worker contract. It does not invent a
 * forecast period, station, wind direction, or unavailable altitude level.
 */
export class WorkerWindsAdapter {
  public constructor(private readonly client: WindsTransportClient) {}

  public async load(input: WorkerWindsSelectionInput): Promise<LoadedWindsData> {
    let discovery: WindsStationsSuccessPayload;
    try {
      discovery = await this.client.discoverStations(input.routeCoordinates);
    } catch (error) {
      throw transportError(error);
    }
    const stations: AvailableWindsStation[] = [];
    for (const station of discovery.stations) {
      const converted = toAvailableStation(station);
      stations.push(requireDomainValue(converted));
    }
    const stationSelection = selectNearestWindsStation(input.stationSelectionCoordinate, stations);
    const selectedStation = requireDomainValue(stationSelection);
    const forecastSelection = selectForecastValidTime(
      forecastPeriods(discovery),
      input.selectedForecastValidTimeUtc,
      input.departureTimeUtc,
    );
    const selectedForecast = requireDomainValue(forecastSelection);
    const discoveryAvailability = requireUniqueDiscoveryAvailability(discovery, selectedForecast.period.id);
    const selectedTransportStation = discovery.stations.find((station) => station.id === selectedStation.station.id);
    if (selectedTransportStation === undefined) {
      throw new WindsAdapterError("INVALID_FORECAST", "Selected station was not present in the discovery response.");
    }
    let forecastPayload: WindsForecastSuccessPayload;
    try {
      forecastPayload = await this.client.fetchForecast(
        selectedStation.station.id,
        selectedForecast.period.id,
        selectedTransportStation.region,
      );
    } catch (error) {
      throw transportError(error);
    }
    validateForecastIdentity(selectedStation, selectedForecast, discoveryAvailability, forecastPayload);
    const actualSelection = selectForecastValidTime(
      [{
        id: forecastPayload.forecast.validAt,
        validFromUtc: forecastPayload.forecast.useFrom,
        validToUtc: forecastPayload.forecast.useUntil,
      }],
      selectedForecast.period.id,
      input.departureTimeUtc,
    );
    const actualForecastSelection = requireDomainValue(actualSelection);
    const levelEvidence = normalizeLevels(forecastPayload.forecast.levels);
    const availableLevels = levelEvidence.flatMap((evidence) => evidence.domainLevel === undefined ? [] : [evidence.domainLevel]);
    if (availableLevels.length === 0) {
      throw new WindsAdapterError("NO_USABLE_LEVELS", "The selected forecast contains no usable winds-aloft levels.");
    }
    return {
      stationSelection: selectedStation,
      forecastSelection: actualForecastSelection,
      forecastPayload,
      stationDiscoveryPayload: discovery,
      availableLevels,
      levelEvidence,
      provenance: {
        discovery: discovery.provenance,
        forecast: forecastPayload.provenance,
        requestIds: { stationDiscovery: discovery.requestId, forecast: forecastPayload.requestId },
      },
    };
  }
}

const transportError = (error: unknown): WindsAdapterError =>
  error instanceof WindsAdapterError
    ? error
    : new WindsAdapterError("TRANSPORT", error instanceof Error && error.message.length > 0 ? error.message : "Winds data could not be loaded.");

/** Resolves an inspectable wind at one altitude from a selected, immutable forecast. */
export const resolveLoadedWindAtAltitude = (
  data: LoadedWindsData,
  altitudeFeetMsl: number,
): DomainResult<AltitudeResolvedWind> => {
  const altitude = feetMsl(altitudeFeetMsl);
  return altitude.ok ? resolveWindAtAltitude(data.availableLevels, altitude.value) : propagateFailure(altitude);
};

/** Resolves sampled phase wind without silently extrapolating beyond published aloft levels. */
export const sampleLoadedEffectivePhaseWind = (
  data: LoadedWindsData,
  startingAltitudeFeetMsl: number,
  targetAltitudeFeetMsl: number,
  options: EffectiveWindSamplingOptions = {},
): DomainResult<EffectivePhaseWind> => {
  const start = feetMsl(startingAltitudeFeetMsl);
  if (!start.ok) return propagateFailure(start);
  const target = feetMsl(targetAltitudeFeetMsl);
  if (!target.ok) return propagateFailure(target);
  return sampleEffectivePhaseWind(data.availableLevels, start.value, target.value, options);
};

/** Bridges selected immutable forecast data into bounded phase convergence. */
export const createSampledPhaseWindResolver = (data: LoadedWindsData): EffectiveWindResolver => ({
  resolveEffectiveWind(request): DomainResult<Wind> {
    const effective = sampleLoadedEffectivePhaseWind(data, request.startingAltitudeFeetMsl, request.targetAltitudeFeetMsl);
    return effective.ok ? { ok: true, value: effective.value.wind } : propagateFailure(effective);
  },
});
