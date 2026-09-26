import type { PlanRevision } from "../domain/route";

export type NavlogInspectionField = "altitude" | "trueCourse" | "wind" | "windCorrectionAngle" | "trueHeading" | "variation" | "magneticHeading" | "compassDeviation" | "compassHeading" | "distance" | "groundspeed" | "estimatedTimeEnroute" | "fuel";

export interface NavlogInspectionSelection {
  readonly rowIndex: number;
  readonly field: NavlogInspectionField;
}

const labels: Readonly<Record<NavlogInspectionField, string>> = {
  altitude: "Altitude", trueCourse: "True course", wind: "Effective wind", windCorrectionAngle: "Wind correction angle",
  trueHeading: "True heading", variation: "Magnetic variation", magneticHeading: "Magnetic heading",
  compassDeviation: "Compass deviation", compassHeading: "Compass heading", distance: "Distance",
  groundspeed: "Groundspeed", estimatedTimeEnroute: "Estimated time enroute", fuel: "Fuel",
};

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => typeof value === "object" && value !== null && !Array.isArray(value);
const nested = (value: unknown, key: string): RecordValue | undefined => record(value) && record(value[key]) ? value[key] : undefined;

/** Renders saved evidence as text nodes, never as executable weather or user markup. */
export function renderCalculationInspector(revision: PlanRevision | undefined, selection: NavlogInspectionSelection | undefined): HTMLElement {
  const section = document.createElement("section");
  section.className = "calculation-inspector";
  const heading = document.createElement("h3");
  heading.tabIndex = -1;
  heading.textContent = "Selected calculation";
  section.append(heading);
  const row = selectedRow(revision, selection);
  if (selection === undefined || row === undefined) {
    section.append(paragraph("Choose a value in the calculated navlog to see its source, unrounded value, and calculation steps."));
    return section;
  }
  appendSelectedCalculation(section, heading, revision, selection, row);
  return section;
}

function selectedRow(revision: PlanRevision | undefined, selection: NavlogInspectionSelection | undefined): RecordValue | undefined {
  const rows = nested(revision?.calculationSnapshot, "navlog")?.rows;
  return selection !== undefined && Array.isArray(rows) && record(rows[selection.rowIndex]) ? rows[selection.rowIndex] : undefined;
}

function appendSelectedCalculation(section: HTMLElement, heading: HTMLElement, revision: PlanRevision | undefined, selection: NavlogInspectionSelection, row: RecordValue): void {
  heading.textContent = selectionHeading(revision, selection, row);
  const value = selectedValue(row, selection.field);
  section.append(paragraph(`Stored unrounded value: ${displayValue(value)}.`));
  if (["groundspeed", "estimatedTimeEnroute", "fuel"].includes(selection.field)) {
    section.append(paragraph("Effective wind used for this row"));
    appendTrace(section, nested(row.effectiveWind, "trace"));
  }
  if (selection.field === "estimatedTimeEnroute" || selection.field === "fuel") {
    section.append(paragraph("Wind-triangle groundspeed used by this calculation"));
    appendTrace(section, nested(nested(row, "traces"), "windTriangle"));
  }
  section.append(paragraph("Selected value calculation"));
  appendTrace(section, selectedTrace(row, selection.field));
  appendProvenance(section, selectedProvenance(row, selection.field));
  appendEndpointSources(section, revision);
  appendTextList(section, "Assumptions", row.assumptions);
  appendOverrides(section, row.appliedOverrides);
}

function appendEndpointSources(section: HTMLElement, revision: PlanRevision | undefined): void {
  const sources = nested(nested(revision?.calculationSnapshot, "weather"), "endpointSources");
  if (sources === undefined) return;
  const heading = document.createElement("h4");
  heading.textContent = "Endpoint weather sources";
  section.append(heading);
  for (const [key, label] of [["departureMetar", "Departure METAR"], ["destinationTaf", "Destination TAF"], ["destinationMetar", "Destination METAR"]] as const) {
    const source = nested(sources, key);
    if (source === undefined) continue;
    section.append(endpointSourceParagraph(key, label, source));
  }
}

function endpointSourceParagraph(key: string, label: string, source: RecordValue): HTMLParagraphElement {
  const status = key === "departureMetar" ? "Departure surface anchor" : source.selectedForTerminalWind === true ? "Selected for terminal wind" : "Fetched source; not selected for terminal wind";
  const timing = key === "destinationTaf" ? tafValidity(source) : metarTiming(source);
  return paragraph(`${label} (${status}): ${String(source.stationIcao ?? "unknown station")}; request ${String(source.requestId ?? "unknown")}; issued ${String(source.issuedAt ?? "unknown")}; ${timing}; ${cacheDescription(source)}.`);
}

function tafValidity(source: RecordValue): string {
  return `valid ${String(source.validFrom ?? "unknown")} to ${String(source.validUntil ?? "unknown")}`;
}

function metarTiming(source: RecordValue): string {
  return `fetched ${String(source.fetchedAt ?? "unknown")}; observed ${String(source.observedAt ?? "not available")}`;
}

function cacheDescription(source: RecordValue): string {
  const cache = nested(source, "cache");
  if (cache === undefined) return "cache not reported";
  return `cache ${String(cache.status ?? "unknown")} from ${String(cache.source ?? "unknown")}; fetched ${String(cache.fetchedAt ?? "unknown")}; expires ${String(cache.expiresAt ?? "unknown")}; freshness ${String(cache.freshnessRemainingSeconds ?? "unknown")} seconds`;
}

function selectionHeading(revision: PlanRevision | undefined, selection: NavlogInspectionSelection, row: RecordValue): string {
  const subleg = nested(row, "subleg");
  const source = revision?.draftSnapshot.route.legs.find((leg) => leg.id === subleg?.sourceLegId);
  const from = revision?.draftSnapshot.route.points.find((point) => point.id === source?.fromPointId)?.name ?? "Unknown origin";
  const to = revision?.draftSnapshot.route.points.find((point) => point.id === source?.toPointId)?.name ?? "unknown destination";
  return `${labels[selection.field]} · ${from} → ${to} · ${String(subleg?.phase ?? "phase unknown")}`;
}

function appendTrace(section: HTMLElement, trace: RecordValue | undefined): void {
  if (trace === undefined) {
    section.append(paragraph("This value comes from route or phase allocation; no detailed trace was stored for it."));
  } else {
    renderTrace(section, trace);
  }
}

function appendProvenance(section: HTMLElement, provenance: RecordValue | undefined): void {
  if (provenance === undefined) return;
  section.append(paragraph(`Origin: ${String(provenance.origin ?? "unspecified")}. Source: ${String(nested(provenance, "provenance")?.sourceLabel ?? "unspecified")}.`));
}

function selectedValue(row: RecordValue, field: NavlogInspectionField): unknown {
  const subleg = nested(row, "subleg");
  if (field === "altitude") return `${displayValue(subleg?.startingAltitude)} → ${displayValue(subleg?.endingAltitude)} ft MSL`;
  if (field === "trueCourse") return subleg?.trueCourse;
  if (field === "distance") return subleg?.distance;
  if (field === "wind") return nested(nested(row, "effectiveWind")?.wind, "effectiveValue");
  if (field === "variation") return nested(row, "variation")?.effectiveValue;
  return row[field];
}

function selectedTrace(row: RecordValue, field: NavlogInspectionField): RecordValue | undefined {
  if (field === "wind") return nested(row.effectiveWind, "trace");
  const traces = nested(row, "traces");
  const key: Partial<Record<NavlogInspectionField, string>> = {
    windCorrectionAngle: "windTriangle", trueHeading: "windTriangle", groundspeed: "windTriangle",
    variation: "magneticVariation", magneticHeading: "trueToMagnetic", compassDeviation: "compassDeviation",
    compassHeading: "magneticToCompass", estimatedTimeEnroute: "estimatedTimeEnroute", fuel: "fuel",
  };
  const traceKey = key[field];
  return traceKey === undefined ? undefined : nested(traces, traceKey);
}

function selectedProvenance(row: RecordValue, field: NavlogInspectionField): RecordValue | undefined {
  if (field === "wind") return nested(nested(row, "effectiveWind"), "wind");
  if (field === "variation") return nested(row, "variation");
  return undefined;
}

function renderTrace(section: HTMLElement, trace: RecordValue): void {
  section.append(paragraph(`Formula: ${String(trace.formulaId ?? "unknown")} · version ${String(trace.formulaVersion ?? "unknown")}.`));
  appendTraceValues(section, "Inputs", trace.inputs);
  appendTraceValues(section, "Intermediate results", trace.intermediateValues);
  appendTraceValues(section, "Result", trace.result === undefined ? [] : [trace.result]);
  const rounding = nested(trace, "rounding");
  if (rounding !== undefined) section.append(paragraph(`Rounding: calculated ${String(rounding.calculation ?? "unrounded")}; display ${String(rounding.display ?? "not specified")}.`));
  appendTextList(section, "Warnings", trace.warnings);
}

function appendTraceValues(section: HTMLElement, title: string, raw: unknown): void {
  if (!Array.isArray(raw) || raw.length === 0) return;
  const heading = document.createElement("h4");
  heading.textContent = title;
  const list = document.createElement("dl");
  for (const item of raw) {
    if (!record(item)) continue;
    const name = document.createElement("dt");
    name.textContent = String(item.name ?? "Value");
    const value = document.createElement("dd");
    value.textContent = `${displayValue(item.value)} ${String(item.unit ?? "")}`.trim();
    list.append(name, value);
  }
  section.append(heading, list);
}

function appendTextList(section: HTMLElement, title: string, raw: unknown): void {
  if (!Array.isArray(raw) || raw.length === 0) return;
  const heading = document.createElement("h4");
  heading.textContent = title;
  const list = document.createElement("ul");
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const entry = document.createElement("li");
    entry.textContent = item;
    list.append(entry);
  }
  section.append(heading, list);
}

function appendOverrides(section: HTMLElement, raw: unknown): void {
  if (!Array.isArray(raw) || raw.length === 0) return;
  const heading = document.createElement("h4");
  heading.textContent = "Applied overrides";
  const list = document.createElement("ul");
  for (const item of raw) {
    if (!record(item)) continue;
    const entry = document.createElement("li");
    entry.textContent = `${String(item.input ?? "Value")}: ${displayValue(item.computedValue)} → ${displayValue(item.effectiveValue)}${typeof item.reason === "string" ? `; reason: ${item.reason}` : ""}`;
    list.append(entry);
  }
  section.append(heading, list);
}

function displayValue(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" || typeof value === "boolean") return String(value);
  if (record(value) && typeof value.directionFrom === "number" && typeof value.speed === "number") return `${value.directionFrom}° from at ${value.speed} kt`;
  return "unavailable";
}

function paragraph(value: string): HTMLParagraphElement {
  const element = document.createElement("p");
  element.textContent = value;
  return element;
}
