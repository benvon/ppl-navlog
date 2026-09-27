import type { PlanRevision } from "../domain/route";
import type { NavlogInspectionSelection, NavlogInspectionField } from "./calculation-inspector";

type RecordValue = Record<string, unknown>;
type NavlogEndpoint = { readonly kind: "pattern-altitude-airport" | "pattern-altitude-3nm"; readonly routeDistanceNauticalMiles: number };
const record = (value: unknown): value is RecordValue => typeof value === "object" && value !== null && !Array.isArray(value);
const nested = (value: unknown, key: string): RecordValue | undefined => record(value) && record(value[key]) ? value[key] : undefined;
const number = (value: unknown): string => typeof value === "number" && Number.isFinite(value) ? value.toFixed(1) : "—";
const wholeNumber = (value: unknown): string => typeof value === "number" && Number.isFinite(value) ? String(Math.round(value)) : "—";
const text = (value: unknown): string => typeof value === "string" ? value : "—";
const cell = (content: string | HTMLElement): HTMLTableCellElement => {
  const element = document.createElement("td");
  if (typeof content === "string") element.textContent = content;
  else element.append(content);
  return element;
};

/** Renders only validated-enough local snapshot structure, never markup from weather data. */
export interface CalculatedNavlogViewOptions {
  readonly onInspect?: (selection: NavlogInspectionSelection) => void;
  readonly selected?: NavlogInspectionSelection;
  readonly currentWeatherValidated?: boolean;
}

export const renderCalculatedNavlog = (revision: PlanRevision, options: CalculatedNavlogViewOptions = {}): HTMLElement | undefined => {
  const snapshot = completeNavlogSnapshot(revision.calculationSnapshot);
  if (snapshot === undefined) return undefined;
  const section = document.createElement("section");
  section.className = "calculated-navlog";
  if (snapshot.status === "infeasible-phase-allocation") {
    return renderInfeasibleNavlog(section, snapshot);
  }
  const navlog = calculatedNavlog(snapshot);
  if (navlog === undefined) return renderIncompleteNavlog(section);
  const phaseAllocation = nested(snapshot, "phaseAllocation");
  return renderCalculatedResult(section, navlog, revision, options, phaseAllocation?.boundaries, navlogEndpoint(phaseAllocation));
};

const completeNavlogSnapshot = (snapshot: unknown): RecordValue | undefined =>
  record(snapshot) && snapshot.schema === "complete-navlog/v1" ? snapshot : undefined;

const calculatedNavlog = (snapshot: RecordValue): RecordValue | undefined => {
  const navlog = nested(snapshot, "navlog");
  return snapshot.status === "calculated" && Array.isArray(navlog?.rows) && navlog.rows.every(record) ? navlog : undefined;
};

const navlogEndpoint = (phaseAllocation: RecordValue | undefined): NavlogEndpoint | undefined => {
  const endpoint = nested(phaseAllocation, "navlogEndpoint");
  return (endpoint?.kind === "pattern-altitude-airport" || endpoint?.kind === "pattern-altitude-3nm")
    && typeof endpoint.routeDistanceNauticalMiles === "number"
    && Number.isFinite(endpoint.routeDistanceNauticalMiles)
    ? { kind: endpoint.kind, routeDistanceNauticalMiles: endpoint.routeDistanceNauticalMiles }
    : undefined;
};

const renderInfeasibleNavlog = (section: HTMLElement, snapshot: RecordValue): HTMLElement => {
  const message = document.createElement("p");
  message.textContent = "The required climb, transition, and descent distances overlap or extend beyond this route. No flyable navlog was invented.";
  section.append(message, details("Phase allocation evidence", snapshot.phaseAllocation));
  return section;
};

const renderIncompleteNavlog = (section: HTMLElement): HTMLElement => {
  const message = document.createElement("p");
  message.textContent = "The saved calculation is incomplete or cannot be displayed safely.";
  section.append(message);
  return section;
};

const renderCalculatedResult = (
  section: HTMLElement,
  navlog: RecordValue,
  revision: PlanRevision,
  options: CalculatedNavlogViewOptions,
  boundaries: unknown,
  endpoint: NavlogEndpoint | undefined,
): HTMLElement => {
  const rows = navlog.rows as readonly RecordValue[];
  if (options.currentWeatherValidated) {
    const currentWeather = document.createElement("p");
    currentWeather.className = "current-weather-status";
    currentWeather.textContent = "Current weather validated for this calculation.";
    section.append(currentWeather);
  }
  const table = document.createElement("table");
  const caption = document.createElement("caption");
  caption.textContent = "Calculated visual flight log";
  table.append(caption, navlogHeader());
  const body = document.createElement("tbody");
  rows.forEach((row, index) => body.append(navlogRow(row, rows, revision, index, options, boundaries, endpoint)));
  table.append(body);
  const scroll = document.createElement("div");
  scroll.className = "navlog-table-scroll";
  scroll.append(table);
  const summary = nested(navlog, "fuelSummary");
  const fuel = document.createElement("p");
  const fuelScope = fuelRequiredScope(endpoint);
  fuel.textContent = `${fuelScope}: ${fuelAmount(summary?.requiredFuel)} gal. Enroute: ${fuelAmount(summary?.enrouteFuel)} gal.`;
  section.append(scroll, fuel);
  const aboardFuel = aboardFuelNotice(summary, endpoint);
  if (aboardFuel !== undefined) section.append(aboardFuel);
  const usableFuel = usableFuelNotice(summary);
  if (usableFuel !== undefined) section.append(usableFuel);
  const warnings = revisionWarnings(revision);
  if (warnings !== undefined) section.append(warnings);
  return section;
};

const fuelRequiredScope = (endpoint: NavlogEndpoint | undefined): string => {
  if (endpoint?.kind === "pattern-altitude-airport") return "Fuel required through destination at pattern altitude, including taxi/run-up and reserve";
  if (endpoint?.kind === "pattern-altitude-3nm") return "Fuel required through 3 NM point, including taxi/run-up and reserve";
  return "Fuel required including taxi/run-up and reserve";
};

const fuelAmount = (value: unknown): string => typeof value !== "number" || !Number.isFinite(value)
  ? "—"
  : value !== 0 && Math.abs(value) < 0.1 ? `${value < 0 ? "−" : ""}<0.1` : value.toFixed(1);
const fuelBalance = (value: unknown): string => typeof value !== "number" || !Number.isFinite(value)
  ? "—"
  : value < 0 ? `Deficit: ${fuelAmount(Math.abs(value))} gal` : `${fuelAmount(value)} gal`;
const endpointFuelBalance = (value: unknown, endpoint: NavlogEndpoint | undefined): string => {
  const location = endpoint?.kind === "pattern-altitude-airport" ? "at destination"
    : endpoint?.kind === "pattern-altitude-3nm" ? "at 3 NM point" : "at arrival";
  return typeof value === "number" && Number.isFinite(value) && value < 0
    ? `Estimated deficit ${location}: ${fuelAmount(Math.abs(value))} gal`
    : `Estimated balance ${location}: ${fuelBalance(value)}`;
};

const aboardFuelNotice = (summary: RecordValue | undefined, endpoint: NavlogEndpoint | undefined): HTMLElement | undefined => {
  if (typeof summary?.fuelAboard !== "number") return undefined;
  const section = document.createElement("section");
  section.className = "aboard-fuel-summary";
  const details = document.createElement("p");
  const reserveAssessment = typeof summary.reserveShortfall === "number" && summary.reserveShortfall > 0
    ? `Reserve shortfall: ${fuelAmount(summary.reserveShortfall)} gal.`
    : `Reserve margin: ${fuelAmount(summary.reserveMargin)} gal above reserve.`;
  const sufficiency = typeof summary.sufficientAboardFuel === "boolean"
    ? `Aboard-fuel sufficiency: ${summary.sufficientAboardFuel ? "sufficient" : "insufficient"} for taxi, route, and reserve.`
    : "";
  details.textContent = `Fuel aboard (pilot input): ${fuelAmount(summary.fuelAboard)} gal. Taxi/run-up (pilot input): ${fuelAmount(summary.taxiRunupFuel)} gal; post-taxi balance (calculated): ${fuelBalance(summary.fuelAfterTaxi)}. ${endpointFuelBalance(summary.estimatedArrivalFuel, endpoint)}. Reserve (pilot input): ${fuelAmount(summary.reserveFuel)} gal. ${reserveAssessment} ${sufficiency}`;
  section.append(details);
  const capacity = capacityComparisonNotice(summary);
  if (capacity) section.append(capacity);
  const warning = aboardFuelWarning(summary);
  if (warning) section.append(warning);
  return section;
};

const capacityComparisonNotice = (summary: RecordValue): HTMLElement | undefined => {
  const unavailable = summary.capacityComparisonAvailable === false
    || (summary.capacityComparisonAvailable === undefined && (summary.usableFuel === undefined || summary.usableFuel === null));
  if (!unavailable) return undefined;
  const capacity = document.createElement("p");
  capacity.textContent = "Usable-fuel capacity comparison unavailable; aboard-fuel sufficiency is evaluated from the entered fuel amount.";
  return capacity;
};

const aboardFuelWarning = (summary: RecordValue): HTMLElement | undefined => {
  const shortfall = typeof summary.reserveShortfall === "number" ? summary.reserveShortfall : 0;
  const exhaustionDeficit = typeof summary.fuelExhaustionDeficit === "number" ? summary.fuelExhaustionDeficit : 0;
  const messages = [
    shortfall > 0 ? `Reserve shortfall: ${fuelAmount(shortfall)} gal.` : undefined,
    exhaustionDeficit > 0 ? `Fuel exhaustion deficit: ${fuelAmount(exhaustionDeficit)} gal.` : undefined,
    summary.fuelExhausted === true && exhaustionDeficit <= 0 ? "Fuel exhausted at arrival (estimated balance is zero). The estimate does not include an available-fuel margin." : undefined,
    summary.sufficientAboardFuel === false && shortfall === 0 && exhaustionDeficit <= 0 && summary.fuelExhausted !== true ? "Fuel aboard is insufficient for this plan." : undefined,
  ].filter((message): message is string => message !== undefined);
  if (messages.length === 0) return undefined;
  const warning = document.createElement("p");
  warning.className = "navlog-fuel-warning";
  warning.textContent = `WARNING: ${messages.join(" ")}`;
  return warning;
};

const usableFuelNotice = (summary: RecordValue | undefined): HTMLElement | undefined => {
  if (typeof summary?.usableFuel !== "number" || typeof summary.usableFuelDifference !== "number") return undefined;
  const notice = document.createElement("p");
  if (summary.sufficientUsableFuel === false) {
    notice.className = "navlog-fuel-warning";
    notice.textContent = `WARNING: Usable fuel is ${fuelAmount(summary.usableFuel)} gal; this plan is short ${fuelAmount(Math.abs(summary.usableFuelDifference))} gal of required fuel.`;
  } else {
    notice.textContent = `Usable fuel: ${fuelAmount(summary.usableFuel)} gal; margin above required fuel: ${fuelAmount(summary.usableFuelDifference)} gal.`;
  }
  return notice;
};

const revisionWarnings = (revision: PlanRevision): HTMLElement | undefined => {
  if (revision.warnings.length === 0) return undefined;
  const section = document.createElement("section");
  section.className = "navlog-warnings";
  const heading = document.createElement("h3");
  heading.textContent = "Planning warnings";
  const list = document.createElement("ul");
  revision.warnings.forEach((warning) => {
    const item = document.createElement("li");
    item.textContent = warning;
    list.append(item);
  });
  section.append(heading, list);
  return section;
};

const navlogHeader = (): HTMLTableSectionElement => {
  const head = document.createElement("thead");
  const row = document.createElement("tr");
  ["Leg / phase", "Altitude ft MSL", "TC°", "Wind true", "WCA°", "TH°", "Var°", "MH°", "Dev°", "CH°", "NM", "GS kt", "ETE min", "Cumulative NM", "Cumulative ETE min", "Fuel used gal", "Balance after row"].forEach((label) => {
    const heading = document.createElement("th");
    heading.scope = "col";
    heading.textContent = label;
    row.append(heading);
  });
  head.append(row);
  return head;
};

const navlogRow = (row: RecordValue, rows: readonly RecordValue[], revision: PlanRevision, rowIndex: number, options: CalculatedNavlogViewOptions, boundaries: unknown, endpoint: NavlogEndpoint | undefined): HTMLTableRowElement => {
  const tr = document.createElement("tr");
  const subleg = nested(row, "subleg");
  const wind = navlogWind(row);
  const cumulative = nested(row, "cumulative");
  const labels = navlogRowLabels(rows, revision, rowIndex, boundaries, endpoint);
  const phaseLabel = `${labels.from} → ${labels.to} · ${text(subleg?.phase)}`;
  tr.append(
    cell(phaseLabel), inspectionCell("altitude", `${wholeNumber(subleg?.startingAltitude)} → ${wholeNumber(subleg?.endingAltitude)}`, subleg, labels, rowIndex, options), inspectionCell("trueCourse", number(subleg?.trueCourse), subleg, labels, rowIndex, options),
    inspectionCell("wind", `${number(wind?.directionFrom)}° / ${number(wind?.speed)} kt`, subleg, labels, rowIndex, options), inspectionCell("windCorrectionAngle", number(row.windCorrectionAngle), subleg, labels, rowIndex, options), inspectionCell("trueHeading", number(row.trueHeading), subleg, labels, rowIndex, options),
    inspectionCell("variation", number(nested(row, "variation")?.effectiveValue), subleg, labels, rowIndex, options), inspectionCell("magneticHeading", number(row.magneticHeading), subleg, labels, rowIndex, options), inspectionCell("compassDeviation", number(row.compassDeviation), subleg, labels, rowIndex, options),
    inspectionCell("compassHeading", number(row.compassHeading), subleg, labels, rowIndex, options), inspectionCell("distance", number(subleg?.distance), subleg, labels, rowIndex, options), inspectionCell("groundspeed", number(row.groundspeed), subleg, labels, rowIndex, options), inspectionCell("estimatedTimeEnroute", wholeNumber(row.estimatedTimeEnroute), subleg, labels, rowIndex, options),
    cell(number(cumulative?.routeDistance)), cell(wholeNumber(cumulative?.estimatedTimeEnroute)),
    inspectionCell("fuel", fuelAmount(row.fuel), subleg, labels, rowIndex, options), cell(fuelBalance(cumulative?.fuelRemaining)),
  );
  return tr;
};

const navlogRowLabels = (
  rows: readonly RecordValue[],
  revision: PlanRevision,
  rowIndex: number,
  boundaries: unknown,
  endpoint: NavlogEndpoint | undefined,
): { from: string; to: string; toCoordinate: unknown } => {
  const subleg = nested(rows[rowIndex], "subleg");
  const source = sourceLabels(revision, subleg);
  const nextSubleg = nested(rows[rowIndex + 1], "subleg");
  const end = generatedEndpoint(subleg, nextSubleg, nested(rows[rowIndex], "cumulative"), boundaries, endpoint, rowIndex, rows.length, source.to, source.toCoordinate);
  const previousSubleg = nested(rows[rowIndex - 1], "subleg");
  const previousSource = sourceLabels(revision, previousSubleg);
  const start = rowIndex === 0
    ? source.from
    : generatedOriginLabel(previousSubleg, subleg, nested(rows[rowIndex - 1], "cumulative"), boundaries, previousSource, source.from);
  return { from: start, to: end, toCoordinate: source.toCoordinate };
};

const navlogWind = (row: RecordValue): RecordValue | undefined => {
  const effectiveWind = nested(row, "effectiveWind");
  const wind = nested(effectiveWind, "wind");
  return nested(wind, "effectiveValue");
};

const inspectionCell = (
  field: NavlogInspectionField,
  value: string,
  subleg: RecordValue | undefined,
  labels: { from: string; to: string; toCoordinate: unknown },
  rowIndex: number,
  options: CalculatedNavlogViewOptions,
): HTMLTableCellElement => {
  if (options.onInspect === undefined) return cell(value);
  const control = document.createElement("button");
  control.type = "button";
  control.className = "navlog-value";
  control.textContent = value;
  control.dataset.rowIndex = String(rowIndex);
  control.dataset.inspectField = field;
  control.setAttribute("aria-label", `Inspect ${field} for ${labels.from} to ${labels.to} ${text(subleg?.phase)} subleg`);
  control.setAttribute("aria-pressed", String(options.selected?.rowIndex === rowIndex && options.selected.field === field));
  control.addEventListener("click", () => options.onInspect?.({ rowIndex, field }));
  return cell(control);
};

const generatedEndpoint = (
  subleg: RecordValue | undefined,
  nextSubleg: RecordValue | undefined,
  cumulative: RecordValue | undefined,
  boundaries: unknown,
  endpoint: NavlogEndpoint | undefined,
  rowIndex: number,
  rowCount: number,
  routeEndpoint: string,
  routeEndpointCoordinate: unknown,
): string => {
  const phase = subleg?.phase;
  const phaseId = subleg?.phaseId;
  const routeDistance = cumulative?.routeDistance;
  return boundaryEndpointLabel(boundaries, routeDistance, routeEndpoint, routeEndpointCoordinate)
    ?? patternEndpointLabel(phase, routeDistance, endpoint, rowIndex, rowCount, routeEndpoint)
    ?? legacyGeneratedEndpoint(phase, phaseId, nextSubleg)
    ?? routeEndpoint;
};

const generatedOriginLabel = (
  previousSubleg: RecordValue | undefined,
  currentSubleg: RecordValue | undefined,
  previousCumulative: RecordValue | undefined,
  boundaries: unknown,
  previousSource: { readonly to: string; readonly toCoordinate: unknown },
  fallback: string,
): string => boundaryEndpointLabel(boundaries, previousCumulative?.routeDistance, previousSource.to, previousSource.toCoordinate)
  ?? legacyGeneratedEndpoint(previousSubleg?.phase, previousSubleg?.phaseId, currentSubleg)
  ?? fallback;

const boundaryEndpointLabel = (boundaries: unknown, routeDistance: unknown, routeEndpoint: string, routeEndpointCoordinate: unknown): string | undefined => {
  if (!Array.isArray(boundaries) || typeof routeDistance !== "number" || !Number.isFinite(routeDistance)) return undefined;
  const matched = boundaries.filter((candidate) => boundaryMatchesDistance(candidate, routeDistance));
  const names = [...new Set(matched.map(boundaryName).filter((name): name is string => name !== undefined))];
  if (names.length === 0) return undefined;
  const includesWaypoint = matched.some((candidate) => record(candidate) && coordinatesMatch(candidate.coordinate, routeEndpointCoordinate));
  return `${includesWaypoint ? `${routeEndpoint} / ` : ""}${names.join(" / ")}`;
};

const boundaryMatchesDistance = (candidate: unknown, routeDistance: number): boolean => {
  if (!record(candidate)) return false;
  if (candidate.kind !== "top-of-climb" && candidate.kind !== "top-of-descent") return false;
  const boundaryDistance = candidate.routeDistanceNauticalMiles;
  return typeof boundaryDistance === "number" && Number.isFinite(boundaryDistance) && Math.abs(boundaryDistance - routeDistance) <= 0.01;
};

const boundaryName = (candidate: unknown): string | undefined => {
  if (!record(candidate)) return undefined;
  if (candidate.kind === "top-of-climb") return "TOC";
  return candidate.kind === "top-of-descent" ? "TOD" : undefined;
};

const patternEndpointLabel = (phase: unknown, routeDistance: unknown, endpoint: NavlogEndpoint | undefined, rowIndex: number, rowCount: number, routeEndpoint: string): string | undefined => {
  if (phase !== "descent" || rowIndex !== rowCount - 1 || endpoint === undefined) return undefined;
  if (typeof routeDistance !== "number" || Math.abs(endpoint.routeDistanceNauticalMiles - routeDistance) > 0.01) return undefined;
  return endpoint.kind === "pattern-altitude-airport" ? `${routeEndpoint} (pattern altitude)` : "3 NM before destination (pattern altitude)";
};

const legacyGeneratedEndpoint = (phase: unknown, phaseId: unknown, nextSubleg: RecordValue | undefined): string | undefined => {
  if (phase === "climb" && phaseId === "departure-climb" && nextSubleg?.phase === "cruise") return "TOC";
  if (phase === "cruise" && typeof phaseId === "string" && phaseId.endsWith(":to-tod") && nextSubleg?.phaseId === "arrival-descent") return "TOD";
  return undefined;
};

const sourceLabels = (revision: PlanRevision, subleg: RecordValue | undefined): { from: string; to: string; toCoordinate: unknown } => {
  const source = revision.draftSnapshot.route.legs.find((leg) => leg.id === subleg?.sourceLegId);
  const from = revision.draftSnapshot.route.points.find((point) => point.id === source?.fromPointId)?.name ?? text(subleg?.sourceLegId);
  const destination = revision.draftSnapshot.route.points.find((point) => point.id === source?.toPointId);
  const to = destination?.name ?? "—";
  return { from, to, toCoordinate: destination?.coordinate };
};

const coordinatesMatch = (first: unknown, second: unknown): boolean => record(first) && record(second)
  && typeof first.latitude === "number" && typeof first.longitude === "number"
  && typeof second.latitude === "number" && typeof second.longitude === "number"
  && Math.abs(first.latitude - second.latitude) <= 1e-8
  && Math.abs(first.longitude - second.longitude) <= 1e-8;

const details = (label: string, value: unknown): HTMLDetailsElement => {
  const element = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = label;
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(value, null, 2) ?? "Unavailable";
  element.append(summary, pre);
  return element;
};
