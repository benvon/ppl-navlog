import type { MetarData, MetarSuccessPayload, SourceProvenance, WindsAloftLevel, WindsForecastAvailability, WindsForecastSuccessPayload, WindsSourceProvenance, WindsStationsSuccessPayload } from "../../../worker/api/contracts";
import type { CalculationTrace } from "../../domain/calculation-trace";
import { coordinate, sameCoordinate, type Coordinate } from "../../domain/coordinates";
import { failure, propagateFailure, type DomainResult } from "../../domain/errors";
import type { EffectiveWindResolver } from "../../domain/phase-planning";
import { feetMsl, type FeetMsl } from "../../domain/units";
import { windAtAltitude, type Wind, type WindAtAltitude } from "../../domain/wind";
import { resolveWindAtAltitude, type AltitudeResolvedWind } from "../../domain/weather-altitude";
import { sampleEffectivePhaseWind, type EffectivePhaseWind, type EffectiveWindSamplingOptions } from "../../domain/weather-effective-wind";
import { joinSurfaceWindToAloftLevels } from "../../domain/weather-surface-to-aloft";
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
  /**
   * Optional immutable METAR evidence supplied by orchestration. When it is
   * usable, its true wind is anchored at the actual departure field elevation.
   */
  readonly departureSurfaceWind?: DepartureSurfaceWindInput;
}

export interface DepartureSurfaceWindInput {
  /** Exact departure airport identifier and its field elevation. */
  readonly airportIcao: string;
  /** Optional explicit nearby ICAO METAR source; defaults to the departure code when it is ICAO. */
  readonly surfaceWeatherIcao?: string;
  /** Airport-data field elevation, not an elevation parsed from the METAR report. */
  readonly fieldElevationFeetMsl: number;
  readonly metar: MetarSuccessPayload;
}

export interface SurfaceMetarEvidence {
  readonly icao: string;
  readonly metarRaw: string;
  readonly observedAt: string | null;
  readonly fetchedAt: string;
  readonly source: MetarData["source"];
  readonly provenance: SourceProvenance;
  readonly requestId: string;
  readonly wind: MetarData["wind"];
}

export interface AppliedSurfaceToAloftInterpolation {
  readonly status: "applied";
  readonly assumption: "metar-at-field-elevation-vector-interpolated-to-first-fb-level";
  readonly statement: string;
  readonly airportIcao: string;
  readonly surfaceWeatherIcao: string;
  readonly fieldElevationFeetMsl: number;
  readonly fieldElevationSource: "departure-airport-data";
  readonly metar: SurfaceMetarEvidence;
  readonly directionTreatment: "fixed-true" | "calm-normalized-to-000";
  readonly firstAloftLevel: WindLevelEvidence;
  readonly trace: CalculationTrace;
}

export interface UnavailableSurfaceToAloftInterpolation {
  readonly status: "unavailable";
  readonly airportIcao: string;
  readonly surfaceWeatherIcao: string;
  readonly fieldElevationFeetMsl: number;
  readonly fieldElevationSource: "departure-airport-data";
  readonly metar: SurfaceMetarEvidence;
  readonly reason:
    | "airport-identity-mismatch"
    | "invalid-field-elevation"
    | "stale-cache-response"
    | "observation-time-unavailable"
    | "observation-outside-departure-window"
    | "variable-direction"
    | "unusable-surface-wind"
    | "no-aloft-level-above-field";
  readonly statement: string;
}

/** Explicit evidence for the approved planning interpolation, or why it was not used. */
export type SurfaceToAloftInterpolation = AppliedSurfaceToAloftInterpolation | UnavailableSurfaceToAloftInterpolation;

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
  /** Visible surface-METAR interpolation evidence; omitted only when no METAR was supplied. */
  readonly surfaceToAloftInterpolation?: SurfaceToAloftInterpolation;
  /** Raw, typed transport records suitable for an immutable weather snapshot. */
  readonly provenance: {
    readonly discovery: readonly WindsSourceProvenance[];
    readonly forecast: WindsSourceProvenance;
    readonly requestIds: { readonly stationDiscovery: string; readonly forecast: string };
  };
}

/** A sampled phase result accompanied by the applied surface assumption when that phase used it. */
export interface LoadedEffectivePhaseWind extends EffectivePhaseWind {
  readonly surfaceToAloftInterpolation?: AppliedSurfaceToAloftInterpolation;
}

/** Wind evidence for one allocated navlog subleg. Equal altitudes resolve directly, not by sampling. */
export interface LoadedSublegWindResolution {
  readonly wind: Wind;
  readonly trace: CalculationTrace;
  readonly method: "direct-altitude-resolution" | "sampled-phase-wind";
  readonly surfaceToAloftInterpolation?: AppliedSurfaceToAloftInterpolation;
}

export class WindsAdapterError extends Error {
  public constructor(readonly code: "TRANSPORT" | "SELECTION" | "INVALID_FORECAST" | "NO_USABLE_LEVELS", message: string) {
    super(message);
    this.name = "WindsAdapterError";
  }
}

const METAR_MAX_OBSERVATION_AGE_MS = 2 * 60 * 60 * 1_000;

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

const metarEvidence = (metar: MetarSuccessPayload): SurfaceMetarEvidence => ({
  icao: metar.metar.icao,
  metarRaw: metar.metar.metarRaw,
  observedAt: metar.metar.observedAt,
  fetchedAt: metar.metar.fetchedAt,
  source: metar.metar.source,
  provenance: metar.provenance,
  requestId: metar.requestId,
  wind: metar.metar.wind,
});

const unavailableSurfaceInterpolation = (
  input: DepartureSurfaceWindInput,
  reason: UnavailableSurfaceToAloftInterpolation["reason"],
  statement: string,
): UnavailableSurfaceToAloftInterpolation => ({
  status: "unavailable",
  airportIcao: input.airportIcao,
  surfaceWeatherIcao: input.surfaceWeatherIcao ?? input.airportIcao,
  fieldElevationFeetMsl: input.fieldElevationFeetMsl,
  fieldElevationSource: "departure-airport-data",
  metar: metarEvidence(input.metar),
  reason,
  statement,
});

interface UsableSurfaceWind {
  readonly fieldElevation: FeetMsl;
  readonly direction: number;
  readonly speedKt: number;
  readonly directionTreatment: AppliedSurfaceToAloftInterpolation["directionTreatment"];
}

const validatedFieldElevation = (input: DepartureSurfaceWindInput): FeetMsl | UnavailableSurfaceToAloftInterpolation => {
  const surfaceWeatherIcao = input.surfaceWeatherIcao ?? input.airportIcao;
  if (input.metar.metar.icao !== surfaceWeatherIcao) {
    return unavailableSurfaceInterpolation(input, "airport-identity-mismatch", "Surface-METAR interpolation was not used because the METAR airport identity does not match the selected surface-weather source.");
  }
  const fieldElevation = feetMsl(input.fieldElevationFeetMsl);
  return fieldElevation.ok
    ? fieldElevation.value
    : unavailableSurfaceInterpolation(input, "invalid-field-elevation", "Surface-METAR interpolation was not used because the departure field elevation is invalid.");
};

const metarObservationIsUsable = (
  input: DepartureSurfaceWindInput,
  departureTimeUtc: string,
): UnavailableSurfaceToAloftInterpolation | undefined => {
  const source = input.metar;
  if (source.provenance.cache.status === "stale_on_error" || source.provenance.cache.freshnessRemainingSeconds <= 0) {
    return unavailableSurfaceInterpolation(input, "stale-cache-response", "Surface-METAR interpolation was not used because the METAR response is stale.");
  }
  const observedMs = source.metar.observedAt === null ? Number.NaN : Date.parse(source.metar.observedAt);
  if (!Number.isFinite(observedMs)) {
    return unavailableSurfaceInterpolation(input, "observation-time-unavailable", "Surface-METAR interpolation was not used because the METAR observation time is unavailable.");
  }
  const departureMs = Date.parse(departureTimeUtc);
  if (!Number.isFinite(departureMs) || observedMs > departureMs || departureMs - observedMs > METAR_MAX_OBSERVATION_AGE_MS) {
    return unavailableSurfaceInterpolation(input, "observation-outside-departure-window", "Surface-METAR interpolation was not used because the observation is outside the documented two-hour window at or before departure.");
  }
  return undefined;
};

const usableSurfaceWind = (input: DepartureSurfaceWindInput, fieldElevation: FeetMsl): UsableSurfaceWind | UnavailableSurfaceToAloftInterpolation => {
  const surfaceWind = input.metar.metar.wind;
  if (surfaceWind.directionType === "variable") {
    return unavailableSurfaceInterpolation(input, "variable-direction", "Surface-METAR interpolation was not used because a variable wind has no single true-direction vector.");
  }
  const directionTreatment = surfaceWind.directionType === "calm" ? "calm-normalized-to-000" : "fixed-true";
  const direction = surfaceWind.directionType === "calm" ? 0 : surfaceWind.directionDegTrue;
  if (direction === null || !Number.isFinite(direction) || !Number.isFinite(surfaceWind.speedKt) || surfaceWind.speedKt < 0) {
    return unavailableSurfaceInterpolation(input, "unusable-surface-wind", "Surface-METAR interpolation was not used because the METAR does not contain a usable fixed or calm wind.");
  }
  return { fieldElevation, direction, speedKt: surfaceWind.speedKt, directionTreatment };
};

const surfacePrerequisites = (
  input: DepartureSurfaceWindInput,
  departureTimeUtc: string,
): UsableSurfaceWind | UnavailableSurfaceToAloftInterpolation => {
  const fieldElevation = validatedFieldElevation(input);
  if (typeof fieldElevation !== "number") return fieldElevation;
  const observationIssue = metarObservationIsUsable(input, departureTimeUtc);
  if (observationIssue !== undefined) return observationIssue;
  return usableSurfaceWind(input, fieldElevation);
};

const resolveSurfaceToAloftInterpolation = (
  input: DepartureSurfaceWindInput,
  departureTimeUtc: string,
  availableLevels: readonly WindAtAltitude[],
  levelEvidence: readonly WindLevelEvidence[],
): { readonly levels: readonly WindAtAltitude[]; readonly evidence: SurfaceToAloftInterpolation } => {
  const prerequisites = surfacePrerequisites(input, departureTimeUtc);
  if ("status" in prerequisites) return { levels: availableLevels, evidence: prerequisites };
  const anchor = windAtAltitude(prerequisites.fieldElevation, prerequisites.direction, prerequisites.speedKt);
  if (!anchor.ok) {
    return {
      levels: availableLevels,
      evidence: unavailableSurfaceInterpolation(input, "unusable-surface-wind", "Surface-METAR interpolation was not used because the parsed surface wind is invalid."),
    };
  }
  const joined = joinSurfaceWindToAloftLevels(anchor.value, availableLevels);
  if (!joined.ok) {
    return {
      levels: availableLevels,
      evidence: unavailableSurfaceInterpolation(input, "no-aloft-level-above-field", "Surface-METAR interpolation was not used because no published FB level is available above the departure field."),
    };
  }
  const firstAloftLevel = levelEvidence.find((level) => level.domainLevel?.altitude === joined.value.firstAloftLevel.altitude);
  if (firstAloftLevel === undefined) {
    // This would require a mismatch between normalized evidence and its levels.
    return {
      levels: availableLevels,
      evidence: unavailableSurfaceInterpolation(input, "no-aloft-level-above-field", "Surface-METAR interpolation was not used because the selected FB level evidence is unavailable."),
    };
  }
  return {
    levels: joined.value.levels,
    evidence: {
      status: "applied",
      assumption: "metar-at-field-elevation-vector-interpolated-to-first-fb-level",
      statement: `Planning assumption: surface METAR ${input.surfaceWeatherIcao ?? input.airportIcao} true wind is anchored at departure airport ${input.airportIcao} field elevation ${input.fieldElevationFeetMsl} ft MSL supplied by airport data (not by the METAR report) and vector-interpolated only to the first available FB winds-aloft level.`,
      airportIcao: input.airportIcao,
      surfaceWeatherIcao: input.surfaceWeatherIcao ?? input.airportIcao,
      fieldElevationFeetMsl: input.fieldElevationFeetMsl,
      fieldElevationSource: "departure-airport-data",
      metar: metarEvidence(input.metar),
      directionTreatment: prerequisites.directionTreatment,
      firstAloftLevel,
      trace: joined.value.trace,
    },
  };
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
    const surfaceResolution = input.departureSurfaceWind === undefined
      ? undefined
      : resolveSurfaceToAloftInterpolation(input.departureSurfaceWind, input.departureTimeUtc, availableLevels, levelEvidence);
    return {
      stationSelection: selectedStation,
      forecastSelection: actualForecastSelection,
      forecastPayload,
      stationDiscoveryPayload: discovery,
      availableLevels: surfaceResolution?.levels ?? availableLevels,
      levelEvidence,
      surfaceToAloftInterpolation: surfaceResolution?.evidence,
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
): DomainResult<LoadedEffectivePhaseWind> => {
  const start = feetMsl(startingAltitudeFeetMsl);
  if (!start.ok) return propagateFailure(start);
  const target = feetMsl(targetAltitudeFeetMsl);
  if (!target.ok) return propagateFailure(target);
  const effective = sampleEffectivePhaseWind(data.availableLevels, start.value, target.value, options);
  if (!effective.ok) return propagateFailure(effective);
  const usesSurfaceInterpolation = appliedSurfaceInterpolationForAltitudeRange(data, start.value, target.value);
  return {
    ok: true,
    value: {
      ...effective.value,
      ...(usesSurfaceInterpolation === undefined ? {} : { surfaceToAloftInterpolation: usesSurfaceInterpolation }),
    },
  };
};

const appliedSurfaceInterpolationForAltitudeRange = (
  data: LoadedWindsData,
  firstAltitudeFeetMsl: number,
  secondAltitudeFeetMsl: number,
): AppliedSurfaceToAloftInterpolation | undefined => {
  const interpolation = data.surfaceToAloftInterpolation;
  if (interpolation?.status !== "applied") return undefined;
  const firstAloftAltitude = interpolation.firstAloftLevel.domainLevel?.altitude;
  if (firstAloftAltitude === undefined) return undefined;
  return Math.min(firstAltitudeFeetMsl, secondAltitudeFeetMsl) < firstAloftAltitude &&
    Math.max(firstAltitudeFeetMsl, secondAltitudeFeetMsl) >= interpolation.fieldElevationFeetMsl
    ? interpolation
    : undefined;
};

/**
 * Resolves weather for one navlog subleg using the selected immutable data.
 * Level sublegs use a direct altitude resolution so they never invoke the
 * phase sampler with identical endpoints.
 */
export const resolveLoadedEffectiveWindForSubleg = (
  data: LoadedWindsData,
  startingAltitudeFeetMsl: number,
  targetAltitudeFeetMsl: number,
  options: EffectiveWindSamplingOptions = {},
): DomainResult<LoadedSublegWindResolution> => {
  if (startingAltitudeFeetMsl === targetAltitudeFeetMsl) {
    const direct = resolveLoadedWindAtAltitude(data, startingAltitudeFeetMsl);
    if (!direct.ok) return propagateFailure(direct);
    const surfaceToAloftInterpolation = appliedSurfaceInterpolationForAltitudeRange(data, startingAltitudeFeetMsl, targetAltitudeFeetMsl);
    return {
      ok: true,
      value: {
        wind: direct.value.wind,
        trace: direct.value.trace,
        method: "direct-altitude-resolution",
        ...(surfaceToAloftInterpolation === undefined ? {} : { surfaceToAloftInterpolation }),
      },
    };
  }
  const sampled = sampleLoadedEffectivePhaseWind(data, startingAltitudeFeetMsl, targetAltitudeFeetMsl, options);
  if (!sampled.ok) return propagateFailure(sampled);
  return {
    ok: true,
    value: {
      wind: sampled.value.wind,
      trace: sampled.value.trace,
      method: "sampled-phase-wind",
      ...(sampled.value.surfaceToAloftInterpolation === undefined ? {} : { surfaceToAloftInterpolation: sampled.value.surfaceToAloftInterpolation }),
    },
  };
};

/** Bridges selected immutable forecast data into bounded phase convergence. */
export const createSampledPhaseWindResolver = (data: LoadedWindsData): EffectiveWindResolver => ({
  resolveEffectiveWind(request): DomainResult<Wind> {
    const effective = sampleLoadedEffectivePhaseWind(data, request.startingAltitudeFeetMsl, request.targetAltitudeFeetMsl);
    return effective.ok ? { ok: true, value: effective.value.wind } : propagateFailure(effective);
  },
});
