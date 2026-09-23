import type { PlanRevision, WeatherReferenceSnapshot } from "../domain/route";

type Data = Record<string, unknown>;
const object = (value: unknown): value is Data => typeof value === "object" && value !== null && !Array.isArray(value);
const child = (value: unknown, key: string): Data | undefined => object(value) && object(value[key]) ? value[key] : undefined;
const string = (value: unknown): string => typeof value === "string" ? value : "Unavailable";
const decimal = (value: unknown, digits = 1): string => typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—";
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, value?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  return node;
};

/** Browser-local, one-way output view of a saved complete calculation. */
export function createPrintableNavlog(revision: PlanRevision, weatherSnapshots: readonly WeatherReferenceSnapshot[]): HTMLElement | undefined {
  const snapshot = revision.calculationSnapshot;
  const navlog = child(snapshot, "navlog");
  if (navlog === undefined || !isPrintable(snapshot, navlog, revision, weatherSnapshots)) return undefined;

  const sheet = element("article");
  sheet.className = "print-sheet";
  sheet.setAttribute("aria-label", "Printable visual flight log");
  sheet.append(element("h1", "Visual Flight Log"), element("p", "Teaching and planning aid only - not an official briefing or a complete preflight plan."));
  const draft = revision.draftSnapshot;
  const airports = draft.route.points.filter((point) => point.kind === "airport");
  sheet.append(metadata([
    ["Plan", draft.title], ["Route", `${airports[0]?.icao ?? "—"} to ${airports.at(-1)?.icao ?? "—"}`],
    ["Aircraft", revision.aircraftProfileSnapshot.profile.name], ["Planned departure (UTC)", draft.departureTimeUtc],
    ["Revision", revision.id], ["Revision saved (UTC)", revision.createdAt],
    ["Forecast valid (UTC)", string(child(snapshot, "weather")?.selectedForecastValidTimeUtc)],
  ]));
  sheet.append(tableForRows(navlog.rows as Data[], revision));
  sheet.append(boundarySection(child(snapshot, "phaseAllocation")));
  sheet.append(fuelSummary(child(navlog, "fuelSummary")));
  sheet.append(sourceSection(weatherSnapshots, revision));
  sheet.append(warningsSection(revision.warnings));
  sheet.append(assumptionsSection(navlog.rows as Data[]));
  sheet.append(element("p", "Values are displayed rounded for readability; calculations and saved evidence retain unrounded values. Verify all data against current official sources before flight."));
  return sheet;
}

const isPrintable = (snapshot: unknown, navlog: Data | undefined, revision: PlanRevision, weatherSnapshots: readonly WeatherReferenceSnapshot[]): boolean => {
  const rows = navlog?.rows;
  const validCalculation = object(snapshot) && snapshot.schema === "complete-navlog/v1" && snapshot.status === "calculated";
  const validRows = Array.isArray(rows) && rows.length > 0 && rows.every(object);
  const validEvidence = revision.weatherSnapshotIds.length > 0 && revision.weatherSnapshotIds.every((id) => weatherSnapshots.some((candidate) => candidate.id === id));
  return validCalculation && validRows && child(navlog, "fuelSummary") !== undefined && validEvidence;
};

const metadata = (entries: readonly (readonly [string, string])[]): HTMLElement => {
  const list = element("dl");
  list.className = "print-metadata";
  for (const [name, value] of entries) list.append(element("dt", name), element("dd", value));
  return list;
};

const tableForRows = (rows: readonly Data[], revision: PlanRevision): HTMLTableElement => {
  const table = element("table");
  table.className = "print-navlog-table";
  table.append(element("caption", "Planned route and generated phase sublegs"));
  const head = element("thead");
  const headings = element("tr");
  ["Leg / phase", "Alt ft MSL", "TC°", "Wind true", "WCA°", "TH°", "Var°", "MH°", "Dev°", "CH°", "NM", "GS kt", "ETE min", "Fuel gal"].forEach((label) => headings.append(element("th", label)));
  head.append(headings);
  table.append(head);
  const body = element("tbody");
  for (const row of rows) body.append(printRow(row, revision));
  table.append(body);
  return table;
};

const printRow = (row: Data, revision: PlanRevision): HTMLTableRowElement => {
  const subleg = child(row, "subleg");
  const wind = child(child(row, "effectiveWind"), "wind");
  const effectiveWind = child(wind, "effectiveValue");
  const { from, to } = sourceLabels(revision, subleg);
  const tr = element("tr");
  [
    `${from} to ${to} / ${string(subleg?.phase)}`,
    `${decimal(subleg?.startingAltitude, 0)} to ${decimal(subleg?.endingAltitude, 0)}`,
    decimal(subleg?.trueCourse), `${decimal(effectiveWind?.directionFrom)} / ${decimal(effectiveWind?.speed)}`,
    decimal(row.windCorrectionAngle), decimal(row.trueHeading), decimal(child(row, "variation")?.effectiveValue),
    decimal(row.magneticHeading), decimal(row.compassDeviation), decimal(row.compassHeading),
    decimal(subleg?.distance), decimal(row.groundspeed), decimal(row.estimatedTimeEnroute), decimal(row.fuel, 2),
  ].forEach((value) => tr.append(element("td", value)));
  return tr;
};

const sourceLabels = (revision: PlanRevision, subleg: Data | undefined): { from: string; to: string } => {
  const sourceLeg = revision.draftSnapshot.route.legs.find((leg) => leg.id === subleg?.sourceLegId);
  const from = revision.draftSnapshot.route.points.find((point) => point.id === sourceLeg?.fromPointId)?.name ?? string(subleg?.sourceLegId);
  const to = revision.draftSnapshot.route.points.find((point) => point.id === sourceLeg?.toPointId)?.name ?? "—";
  return { from, to };
};

const fuelSummary = (summary: Data | undefined): HTMLElement => {
  const section = element("section");
  section.className = "print-fuel-summary";
  section.append(element("h2", "Fuel summary"));
  section.append(metadata([
    ["Taxi / run-up", `${decimal(summary?.taxiRunupFuel, 2)} gal`], ["Climb", `${decimal(summary?.climbFuel, 2)} gal`],
    ["Transitions", `${decimal(summary?.transitionFuel, 2)} gal`], ["Cruise", `${decimal(summary?.cruiseFuel, 2)} gal`],
    ["Descent", `${decimal(summary?.descentFuel, 2)} gal`], ["Enroute", `${decimal(summary?.enrouteFuel, 2)} gal`],
    ["Reserve", `${decimal(summary?.reserveFuel, 2)} gal`], ["Required total", `${decimal(summary?.requiredFuel, 2)} gal`],
    ["Usable fuel", `${decimal(summary?.usableFuel, 2)} gal`], ["Usable minus required", `${decimal(summary?.usableFuelDifference, 2)} gal`],
  ]));
  return section;
};

const boundarySection = (allocation: Data | undefined): HTMLElement => {
  const section = element("section");
  section.append(element("h2", "Generated phase boundaries"));
  const list = element("ul");
  const boundaries = Array.isArray(allocation?.boundaries) ? allocation.boundaries.filter(object) : [];
  boundaries.forEach((boundary) => {
    const coordinate = child(boundary, "coordinate");
    list.append(element("li", `${string(boundary.kind)} - ${decimal(boundary.routeDistance, 2)} NM from departure - ${decimal(coordinate?.latitude, 5)}, ${decimal(coordinate?.longitude, 5)}`));
  });
  section.append(list);
  return section;
};

const sourceSection = (snapshots: readonly WeatherReferenceSnapshot[], revision: PlanRevision): HTMLElement => {
  const section = element("section");
  section.append(element("h2", "Weather evidence"));
  const list = element("ul");
  for (const id of revision.weatherSnapshotIds) {
    const snapshot = snapshots.find((candidate) => candidate.id === id);
    if (snapshot === undefined) continue;
    list.append(element("li", `${snapshot.source} - retrieved ${snapshot.retrievedAt} UTC - snapshot ${snapshot.id}`));
    const interpolation = child(snapshot.payload, "surfaceToAloftInterpolation");
    if (interpolation?.status === "applied") list.append(element("li", `Surface METAR ${string(interpolation.surfaceWeatherIcao)} wind anchored at departure airport ${string(interpolation.airportIcao)} field elevation ${decimal(interpolation.fieldElevationFeetMsl, 0)} ft MSL from ${string(interpolation.fieldElevationSource)}; vector-interpolated toward the first forecast level.`));
  }
  section.append(list);
  return section;
};

const assumptionsSection = (rows: readonly Data[]): HTMLElement => {
  const section = element("section");
  section.append(element("h2", "Assumptions and overrides"));
  const list = element("ul");
  rows.forEach((row, index) => {
    const assumptions = Array.isArray(row.assumptions) ? row.assumptions.filter((value): value is string => typeof value === "string") : [];
    assumptions.forEach((assumption) => list.append(element("li", `Row ${index + 1}: ${assumption}`)));
    const overrides = Array.isArray(row.appliedOverrides) ? row.appliedOverrides.filter(object) : [];
    overrides.forEach((override) => list.append(element("li", `Row ${index + 1} OVERRIDDEN ${string(override.input)}: ${decimal(override.computedValue)} to ${decimal(override.effectiveValue)}. Reason: ${string(override.reason)}`)));
  });
  if (list.childElementCount === 0) list.append(element("li", "No row-level assumptions or overrides recorded."));
  section.append(list);
  return section;
};

const warningsSection = (warnings: readonly string[]): HTMLElement => {
  const section = element("section");
  section.append(element("h2", "Planning warnings"));
  const list = element("ul");
  warnings.forEach((warning) => list.append(element("li", warning)));
  if (warnings.length === 0) list.append(element("li", "No saved planning warnings."));
  section.append(list);
  return section;
};
