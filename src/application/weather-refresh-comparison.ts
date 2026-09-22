import type { JsonValue, WeatherReferenceSnapshot } from "../domain/route";

export interface WeatherRefreshValueChange {
  /** JSON-pointer-like path, rooted at `$`, safe to display as plain text. */
  readonly path: string;
  readonly previous?: JsonValue;
  readonly refreshed?: JsonValue;
}

export interface WeatherRefreshComparison {
  readonly schema: "weather-refresh-comparison/v1";
  readonly parentRevisionId: string;
  readonly weather: {
    readonly priorSnapshotIds: readonly string[];
    readonly refreshedSnapshotIds: readonly string[];
    readonly snapshotSetChanged: boolean;
    readonly contentChanged: boolean;
    readonly changes: readonly WeatherRefreshValueChange[];
  };
  readonly calculation: {
    readonly changed: boolean;
    readonly changes: readonly WeatherRefreshValueChange[];
  };
}

const MAX_REPORTED_CHANGES = 100;
type JsonRecord = { readonly [key: string]: JsonValue };

/**
 * Produces bounded, value-level comparison evidence without treating new
 * immutable IDs as a weather-data change. The IDs are reported separately.
 */
export const compareWeatherRefresh = (
  parentRevisionId: string,
  priorSnapshots: readonly WeatherReferenceSnapshot[],
  refreshedSnapshots: readonly WeatherReferenceSnapshot[],
  previousCalculation: JsonValue | undefined,
  refreshedCalculation: JsonValue,
): WeatherRefreshComparison => {
  const weatherChanges = jsonChanges(
    priorSnapshots.map(comparableWeatherSnapshot),
    refreshedSnapshots.map(comparableWeatherSnapshot),
  );
  const calculationChanges = jsonChanges(comparableCalculation(previousCalculation), comparableCalculation(refreshedCalculation));
  return {
    schema: "weather-refresh-comparison/v1",
    parentRevisionId,
    weather: {
      priorSnapshotIds: priorSnapshots.map((snapshot) => snapshot.id),
      refreshedSnapshotIds: refreshedSnapshots.map((snapshot) => snapshot.id),
      snapshotSetChanged: !sameIdentifierSet(priorSnapshots.map((snapshot) => snapshot.id), refreshedSnapshots.map((snapshot) => snapshot.id)),
      contentChanged: weatherChanges.length > 0,
      changes: weatherChanges,
    },
    calculation: { changed: calculationChanges.length > 0, changes: calculationChanges },
  };
};

/** Adds comparison evidence without replacing the complete-navlog schema. */
export const attachWeatherRefreshComparison = (
  calculationSnapshot: JsonValue,
  comparison: WeatherRefreshComparison,
): JsonValue => {
  if (!isJsonRecord(calculationSnapshot)) throw new Error("A weather refresh calculation must be a JSON object.");
  return { ...calculationSnapshot, weatherRefreshComparison: comparisonAsJson(comparison) };
};

const comparableWeatherSnapshot = (snapshot: WeatherReferenceSnapshot): JsonValue => ({
  source: snapshot.source,
  payload: withoutTransportMetadata(snapshot.payload),
});

/** Request IDs, cache state, and retrieval transport are evidence provenance,
 * not a change in meteorological content. */
const withoutTransportMetadata = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(withoutTransportMetadata);
  if (!isJsonRecord(value)) return value;
  const result: Record<string, JsonValue> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (["requestId", "requestIds", "provenance", "cache", "fetchedAt", "retrievedAt"].includes(key)) continue;
    result[key] = withoutTransportMetadata(nested);
  }
  return result;
};

const comparableCalculation = (value: JsonValue | undefined): JsonValue | undefined => {
  if (!isJsonRecord(value)) return value;
  const calculation = { ...value };
  delete calculation.weatherRefreshComparison;
  return calculation;
};

const comparisonAsJson = (comparison: WeatherRefreshComparison): JsonValue => ({
  schema: comparison.schema,
  parentRevisionId: comparison.parentRevisionId,
  weather: {
    priorSnapshotIds: comparison.weather.priorSnapshotIds,
    refreshedSnapshotIds: comparison.weather.refreshedSnapshotIds,
    snapshotSetChanged: comparison.weather.snapshotSetChanged,
    contentChanged: comparison.weather.contentChanged,
    changes: comparison.weather.changes.map(changeAsJson),
  },
  calculation: {
    changed: comparison.calculation.changed,
    changes: comparison.calculation.changes.map(changeAsJson),
  },
});

const changeAsJson = (change: WeatherRefreshValueChange): JsonValue => ({
  path: change.path,
  ...(change.previous === undefined ? {} : { previous: change.previous }),
  ...(change.refreshed === undefined ? {} : { refreshed: change.refreshed }),
});

const jsonChanges = (previous: JsonValue | undefined, refreshed: JsonValue | undefined): readonly WeatherRefreshValueChange[] => {
  const changes: WeatherRefreshValueChange[] = [];
  collectChanges(previous, refreshed, "$", changes);
  return changes;
};

const collectChanges = (
  previous: JsonValue | undefined,
  refreshed: JsonValue | undefined,
  path: string,
  changes: WeatherRefreshValueChange[],
): void => {
  if (changes.length >= MAX_REPORTED_CHANGES || jsonEqual(previous, refreshed)) return;
  if (isJsonRecord(previous) && isJsonRecord(refreshed)) {
    const keys = [...new Set([...Object.keys(previous), ...Object.keys(refreshed)])].sort();
    keys.forEach((key) => collectChanges(previous[key], refreshed[key], `${path}.${key}`, changes));
    return;
  }
  if (Array.isArray(previous) && Array.isArray(refreshed)) {
    const length = Math.max(previous.length, refreshed.length);
    for (let index = 0; index < length && changes.length < MAX_REPORTED_CHANGES; index += 1) {
      collectChanges(previous[index], refreshed[index], `${path}[${index}]`, changes);
    }
    return;
  }
  changes.push({ path, ...(previous === undefined ? {} : { previous }), ...(refreshed === undefined ? {} : { refreshed }) });
};

const isJsonRecord = (value: JsonValue | undefined): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const jsonEqual = (left: JsonValue | undefined, right: JsonValue | undefined): boolean => {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => jsonEqual(value, right[index]));
  if (!isJsonRecord(left) || !isJsonRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && jsonEqual(left[key], right[key]));
};

const sameIdentifierSet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value) => right.includes(value));
