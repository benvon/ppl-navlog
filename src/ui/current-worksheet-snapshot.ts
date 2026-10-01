type RecordValue = Record<string, unknown>;

const record = (value: unknown): value is RecordValue => typeof value === "object" && value !== null && !Array.isArray(value);
const finiteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** True only for the durable snapshot shape emitted by the current waypoint worksheet. */
export const isCurrentWorksheetSnapshot = (value: unknown): boolean => {
  if (!record(value) || value.schema !== "complete-navlog/v1" || value.status !== "calculated") return false;
  const allocation = record(value.phaseAllocation) ? value.phaseAllocation : undefined;
  return allocation !== undefined && hasCurrentAllocation(allocation) && hasCurrentRows(value.navlog);
};

const hasCurrentAllocation = (allocation: RecordValue): boolean => allocation.transitionPolicy === "stable-cruise-altitude"
  && hasFieldElevationEndpoint(allocation.navlogEndpoint)
  && hasBothGeneratedBoundaries(allocation.boundaries);

const hasFieldElevationEndpoint = (value: unknown): boolean => record(value)
  && value.kind === "field-elevation-airport" && finiteNumber(value.routeDistanceNauticalMiles);

const hasBothGeneratedBoundaries = (value: unknown): boolean => {
  if (!Array.isArray(value)) return false;
  const kinds = new Set(value.filter(record).filter((boundary) => finiteNumber(boundary.routeDistanceNauticalMiles)).map((boundary) => boundary.kind));
  return kinds.has("top-of-climb") && kinds.has("top-of-descent");
};

const hasCurrentRows = (value: unknown): boolean => {
  if (!record(value) || !Array.isArray(value.rows) || value.rows.length === 0) return false;
  return value.rows.every((row) => record(row) && hasCurrentSubleg(row.subleg));
};

const hasCurrentSubleg = (value: unknown): boolean => record(value)
  && value.altitudePresentation === "cruise-assumption" && finiteNumber(value.selectedCruiseAltitude);
