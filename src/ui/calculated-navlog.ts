import type { PlanRevision } from "../domain/route";
import type { NavlogInspectionSelection, NavlogInspectionField } from "./calculation-inspector";

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
export interface CalculatedNavlogViewOptions {
  readonly onInspect?: (selection: NavlogInspectionSelection) => void;
  readonly selected?: NavlogInspectionSelection;
  readonly currentWeatherValidated?: boolean;
}

export const renderCalculatedNavlog = (revision: PlanRevision, options: CalculatedNavlogViewOptions = {}): HTMLElement | undefined => {
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
  return renderCalculatedResult(section, navlog, revision, options);
};

const renderCalculatedResult = (
  section: HTMLElement,
  navlog: RecordValue,
  revision: PlanRevision,
  options: CalculatedNavlogViewOptions,
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
  rows.forEach((row, index) => body.append(navlogRow(row, revision, index, options)));
  table.append(body);
  const scroll = document.createElement("div");
  scroll.className = "navlog-table-scroll";
  scroll.append(table);
  const summary = nested(navlog, "fuelSummary");
  const fuel = document.createElement("p");
  fuel.textContent = `Fuel required including taxi/run-up and reserve: ${number(summary?.requiredFuel)} gal. Enroute: ${number(summary?.enrouteFuel)} gal.`;
  section.append(scroll, fuel);
  const usableFuel = usableFuelNotice(summary);
  if (usableFuel !== undefined) section.append(usableFuel);
  const warnings = revisionWarnings(revision);
  if (warnings !== undefined) section.append(warnings);
  return section;
};

const usableFuelNotice = (summary: RecordValue | undefined): HTMLElement | undefined => {
  if (typeof summary?.usableFuel !== "number" || typeof summary.usableFuelDifference !== "number") return undefined;
  const notice = document.createElement("p");
  if (summary.sufficientUsableFuel === false) {
    notice.className = "navlog-fuel-warning";
    notice.textContent = `WARNING: Usable fuel is ${number(summary.usableFuel)} gal; this plan is short ${number(Math.abs(summary.usableFuelDifference))} gal of required fuel.`;
  } else {
    notice.textContent = `Usable fuel: ${number(summary.usableFuel)} gal; margin above required fuel: ${number(summary.usableFuelDifference)} gal.`;
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
  ["Leg / phase", "Altitude ft MSL", "TC°", "Wind true", "WCA°", "TH°", "Var°", "MH°", "Dev°", "CH°", "NM", "GS kt", "ETE min", "Fuel gal"].forEach((label) => {
    const heading = document.createElement("th");
    heading.scope = "col";
    heading.textContent = label;
    row.append(heading);
  });
  head.append(row);
  return head;
};

const navlogRow = (row: RecordValue, revision: PlanRevision, rowIndex: number, options: CalculatedNavlogViewOptions): HTMLTableRowElement => {
  const tr = document.createElement("tr");
  const subleg = nested(row, "subleg");
  const labels = sourceLabels(revision, subleg);
  const wind = nested(nested(row, "effectiveWind")?.wind, "effectiveValue");
  const phaseLabel = `${labels.from} → ${labels.to} · ${text(subleg?.phase)}`;
  const valueCell = (field: NavlogInspectionField, value: string): HTMLTableCellElement => {
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
  tr.append(
    cell(phaseLabel), valueCell("altitude", `${number(subleg?.startingAltitude)} → ${number(subleg?.endingAltitude)}`), valueCell("trueCourse", number(subleg?.trueCourse)),
    valueCell("wind", `${number(wind?.directionFrom)}° / ${number(wind?.speed)} kt`), valueCell("windCorrectionAngle", number(row.windCorrectionAngle)), valueCell("trueHeading", number(row.trueHeading)),
    valueCell("variation", number(nested(row, "variation")?.effectiveValue)), valueCell("magneticHeading", number(row.magneticHeading)), valueCell("compassDeviation", number(row.compassDeviation)),
    valueCell("compassHeading", number(row.compassHeading)), valueCell("distance", number(subleg?.distance)), valueCell("groundspeed", number(row.groundspeed)), valueCell("estimatedTimeEnroute", number(row.estimatedTimeEnroute)),
    valueCell("fuel", number(row.fuel)),
  );
  return tr;
};

const sourceLabels = (revision: PlanRevision, subleg: RecordValue | undefined): { from: string; to: string } => {
  const source = revision.draftSnapshot.route.legs.find((leg) => leg.id === subleg?.sourceLegId);
  const from = revision.draftSnapshot.route.points.find((point) => point.id === source?.fromPointId)?.name ?? text(subleg?.sourceLegId);
  const to = revision.draftSnapshot.route.points.find((point) => point.id === source?.toPointId)?.name ?? "—";
  return { from, to };
};

const details = (label: string, value: unknown): HTMLDetailsElement => {
  const element = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = label;
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(value, null, 2) ?? "Unavailable";
  element.append(summary, pre);
  return element;
};
