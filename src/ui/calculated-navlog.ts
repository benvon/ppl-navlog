import type { PlanRevision } from "../domain/route";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => typeof value === "object" && value !== null && !Array.isArray(value);
const nested = (value: unknown, key: string): RecordValue | undefined => record(value) && record(value[key]) ? value[key] : undefined;
const number = (value: unknown): string => typeof value === "number" && Number.isFinite(value) ? value.toFixed(1) : "—";
const text = (value: unknown): string => typeof value === "string" ? value : "—";
const cell = (content: string | HTMLElement): HTMLTableCellElement => {
  const element = document.createElement("td");
  if (typeof content === "string") element.textContent = content;
  else element.append(content);
  return element;
};

/** Renders only validated-enough local snapshot structure, never markup from weather data. */
export const renderCalculatedNavlog = (revision: PlanRevision): HTMLElement | undefined => {
  const snapshot = revision.calculationSnapshot;
  if (!record(snapshot) || snapshot.schema !== "complete-navlog/v1") return undefined;
  const section = document.createElement("section");
  section.className = "calculated-navlog";
  if (snapshot.status === "infeasible-phase-allocation") {
    const message = document.createElement("p");
    message.textContent = "The required climb, transition, and descent distances overlap or extend beyond this route. No flyable navlog was invented.";
    section.append(message);
    section.append(details("Phase allocation evidence", snapshot.phaseAllocation));
    return section;
  }
  const navlog = nested(snapshot, "navlog");
  if (snapshot.status !== "calculated" || !Array.isArray(navlog?.rows) || !navlog.rows.every(record)) {
    const message = document.createElement("p");
    message.textContent = "The saved calculation is incomplete or cannot be displayed safely.";
    section.append(message);
    return section;
  }
  const table = document.createElement("table");
  const caption = document.createElement("caption");
  caption.textContent = "Calculated visual flight log — unrounded values are retained in each row's explanation";
  table.append(caption, navlogHeader());
  const body = document.createElement("tbody");
  navlog.rows.forEach((row) => body.append(navlogRow(row, revision)));
  table.append(body);
  const scroll = document.createElement("div");
  scroll.className = "navlog-table-scroll";
  scroll.append(table);
  const summary = nested(navlog, "fuelSummary");
  const fuel = document.createElement("p");
  fuel.textContent = `Fuel required including taxi/run-up and reserve: ${number(summary?.requiredFuel)} gal. Enroute: ${number(summary?.enrouteFuel)} gal.`;
  section.append(scroll, fuel, details("Phase boundaries and weather selection", { phaseAllocation: snapshot.phaseAllocation, weather: snapshot.weather }));
  return section;
};

const navlogHeader = (): HTMLTableSectionElement => {
  const head = document.createElement("thead");
  const row = document.createElement("tr");
  ["Leg / phase", "Altitude ft MSL", "TC°", "Wind true", "WCA°", "TH°", "Var°", "MH°", "Dev°", "CH°", "NM", "GS kt", "ETE min", "Fuel gal", "Explanation"].forEach((label) => {
    const heading = document.createElement("th");
    heading.scope = "col";
    heading.textContent = label;
    row.append(heading);
  });
  head.append(row);
  return head;
};

const navlogRow = (row: RecordValue, revision: PlanRevision): HTMLTableRowElement => {
  const tr = document.createElement("tr");
  const subleg = nested(row, "subleg");
  const labels = sourceLabels(revision, subleg);
  const wind = nested(nested(row, "effectiveWind")?.wind, "effectiveValue");
  const cumulative = nested(row, "cumulative");
  const assumptions = stringArray(row.assumptions);
  const phaseLabel = `${labels.from} → ${labels.to} · ${text(subleg?.phase)}${assumptions.length > 0 ? " · Assumption explained" : ""}`;
  tr.append(
    cell(phaseLabel), cell(`${number(subleg?.startingAltitude)} → ${number(subleg?.endingAltitude)}`), cell(number(subleg?.trueCourse)),
    cell(`${number(wind?.directionFrom)}° / ${number(wind?.speed)} kt`), cell(number(row.windCorrectionAngle)), cell(number(row.trueHeading)),
    cell(number(nested(row, "variation")?.effectiveValue)), cell(number(row.magneticHeading)), cell(number(row.compassDeviation)),
    cell(number(row.compassHeading)), cell(number(subleg?.distance)), cell(number(row.groundspeed)), cell(number(row.estimatedTimeEnroute)),
    cell(number(row.fuel)), cell(details("Show calculation", { assumptions, traces: row.traces, cumulative, appliedOverrides: row.appliedOverrides })),
  );
  return tr;
};

const sourceLabels = (revision: PlanRevision, subleg: RecordValue | undefined): { from: string; to: string } => {
  const source = revision.draftSnapshot.route.legs.find((leg) => leg.id === subleg?.sourceLegId);
  const from = revision.draftSnapshot.route.points.find((point) => point.id === source?.fromPointId)?.name ?? text(subleg?.sourceLegId);
  const to = revision.draftSnapshot.route.points.find((point) => point.id === source?.toPointId)?.name ?? "—";
  return { from, to };
};

const stringArray = (value: unknown): readonly string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const details = (label: string, value: unknown): HTMLDetailsElement => {
  const element = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = label;
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(value, null, 2) ?? "Unavailable";
  element.append(summary, pre);
  return element;
};
