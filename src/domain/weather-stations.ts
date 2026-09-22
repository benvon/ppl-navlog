import { trace, type CalculationTrace } from "./calculation-trace";
import { sameCoordinate, type Coordinate } from "./coordinates";
import { calculateGreatCircleDistanceAndInitialCourse } from "./distance-course";
import { failure, propagateFailure, success, type DomainResult } from "./errors";
import { nauticalMiles, type NauticalMiles } from "./units";

/** A station advertised as available by the selected winds product. */
export interface AvailableWindsStation {
  /** Provider-stable station identifier, preserved verbatim in provenance. */
  readonly id: string;
  readonly coordinate: Coordinate;
  readonly name?: string;
}

export interface NearestWindsStationSelection {
  readonly station: AvailableWindsStation;
  readonly distance: NauticalMiles;
  readonly selectionMethod: "nearest-great-circle-distance-then-station-id";
  readonly trace: CalculationTrace;
}

const stationIdIsValid = (station: AvailableWindsStation): boolean => station.id.trim().length > 0;

const compareStationId = (first: AvailableWindsStation, second: AvailableWindsStation): number => {
  const normalizedFirst = first.id.toUpperCase();
  const normalizedSecond = second.id.toUpperCase();
  if (normalizedFirst < normalizedSecond) return -1;
  if (normalizedFirst > normalizedSecond) return 1;
  if (first.id < second.id) return -1;
  if (first.id > second.id) return 1;
  return 0;
};

const stationDistance = (origin: Coordinate, station: AvailableWindsStation): DomainResult<NauticalMiles> => {
  if (sameCoordinate(origin, station.coordinate)) return nauticalMiles(0);
  const distance = calculateGreatCircleDistanceAndInitialCourse(origin, station.coordinate);
  return distance.ok ? success(distance.value.distance) : propagateFailure(distance);
};

/**
 * Selects the closest station by great-circle distance. Exact ties are broken
 * by case-insensitive station ID, then original station ID, for repeatability.
 */
export const selectNearestWindsStation = (
  routeCoordinate: Coordinate,
  stations: readonly AvailableWindsStation[],
): DomainResult<NearestWindsStationSelection> => {
  if (stations.length === 0) {
    return failure("NO_WIND_STATIONS", "No winds-aloft stations are available for the selected forecast product.");
  }
  let selectedStation: AvailableWindsStation | undefined;
  let selectedDistance: NauticalMiles | undefined;
  for (const station of stations) {
    if (!stationIdIsValid(station)) {
      return failure("INVALID_WIND_STATION", "A winds station must have a non-empty identifier.", { stationId: station.id });
    }
    const distance = stationDistance(routeCoordinate, station);
    if (!distance.ok) return propagateFailure(distance);
    if (
      selectedStation === undefined ||
      selectedDistance === undefined ||
      distance.value < selectedDistance ||
      (distance.value === selectedDistance && compareStationId(station, selectedStation) < 0)
    ) {
      selectedStation = station;
      selectedDistance = distance.value;
    }
  }
  if (selectedStation === undefined || selectedDistance === undefined) {
    return failure("NO_WIND_STATIONS", "No winds-aloft stations are available for the selected forecast product.");
  }
  return success({
    station: selectedStation,
    distance: selectedDistance,
    selectionMethod: "nearest-great-circle-distance-then-station-id",
    trace: trace(
      "nearest-winds-station-selection",
      [
        { name: "route latitude", value: routeCoordinate.latitude, unit: "degrees" },
        { name: "route longitude", value: routeCoordinate.longitude, unit: "degrees" },
        { name: "available station count", value: stations.length, unit: "unitless" },
      ],
      [
        { name: "selected station", value: selectedStation.id, unit: "unitless" },
        { name: "selection method", value: "great-circle distance; station ID tie-break", unit: "unitless" },
      ],
      { name: "station distance", value: selectedDistance, unit: "nautical-miles" },
    ),
  });
};
