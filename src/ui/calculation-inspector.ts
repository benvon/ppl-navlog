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
  section.append(paragraph(`Result: ${worksheetResult(value, selection.field, row)} as shown in the navlog. Stored unrounded value: ${displayValue(value)}.`));
  const walkthrough = document.createElement("section");
  walkthrough.className = "calculation-walkthrough";
  const walkthroughHeading = document.createElement("h4");
  walkthroughHeading.textContent = "How it was calculated";
  walkthrough.append(walkthroughHeading);
  appendWalkthrough(walkthrough, row, selection.field);
  section.append(walkthrough);
  appendTextList(section, "Planning assumptions", row.assumptions);
  appendOverrides(section, row.appliedOverrides);
  const technical = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Data sources and technical details";
  technical.append(summary);
  appendSupportingHeadingTraces(technical, row, selection.field);
  if (["groundspeed", "estimatedTimeEnroute", "fuel"].includes(selection.field)) {
    technical.append(paragraph("Effective wind used for this row"));
    appendTrace(technical, nested(row.effectiveWind, "trace"));
  }
  if (selection.field === "estimatedTimeEnroute" || selection.field === "fuel") {
    technical.append(paragraph("Wind-triangle groundspeed used by this calculation"));
    appendTrace(technical, nested(nested(row, "traces"), "windTriangle"));
  }
  if (selection.field === "fuel") appendTrace(technical, nested(nested(row, "traces"), "estimatedTimeEnroute"));
  technical.append(paragraph("Selected value calculation"));
  appendTrace(technical, selectedTrace(row, selection.field));
  appendProvenance(technical, selectedProvenance(row, selection.field));
  appendEndpointSources(technical, revision);
  section.append(technical);
}

function appendSupportingHeadingTraces(section: HTMLElement, row: RecordValue, field: NavlogInspectionField): void {
  if (!isHeadingField(field)) return;
  const traces = nested(row, "traces");
  const windTrace = nested(nested(row, "effectiveWind"), "trace");
  if (windTrace !== undefined) {
    section.append(paragraph("Effective wind source"));
    appendTrace(section, windTrace);
  }
  const entries: Array<[string, string]> = [["Wind triangle", "windTriangle"]];
  if (field === "magneticHeading" || field === "compassHeading") entries.push(["Magnetic variation", "magneticVariation"], ["True to magnetic", "trueToMagnetic"]);
  if (field === "compassHeading") entries.push(["Compass deviation", "compassDeviation"], ["Magnetic to compass", "magneticToCompass"]);
  for (const [label, key] of entries) {
    const trace = nested(traces, key);
    if (trace !== undefined) {
      section.append(paragraph(label));
      appendTrace(section, trace);
    }
  }
}

function appendWalkthrough(section: HTMLElement, row: RecordValue, field: NavlogInspectionField): void {
  const subleg = nested(row, "subleg");
  const traces = nested(row, "traces");
  const steps: Array<[string, string]> = [];
  if (isWindDerivedField(field)) appendWindSteps(steps, row, subleg, traces, ["groundspeed", "estimatedTimeEnroute", "fuel"].includes(field));
  if (isHeadingField(field)) appendHeadingSteps(steps, row, subleg, field);
  if (field === "estimatedTimeEnroute" || field === "fuel") appendTimeFuelSteps(steps, row, subleg, field);
  if (!isWindDerivedField(field) && !["estimatedTimeEnroute", "fuel"].includes(field)) appendSourceValueStep(steps, row, subleg, field);
  if (steps.length === 0) {
    section.append(paragraph("This value comes from route or phase allocation; no detailed trace was stored for it."));
    return;
  }
  const list = document.createElement("ol");
  for (const [title, explanation] of steps) {
    const item = document.createElement("li");
    const label = document.createElement("strong");
    label.textContent = `${title}: `;
    item.append(label, document.createTextNode(explanation));
    list.append(item);
  }
  section.append(list, paragraph("Navlog values are displayed to one decimal where applicable; calculations carry the stored values forward without reusing rounded display values."));
}

const isWindDerivedField = (field: NavlogInspectionField): boolean => ["windCorrectionAngle", "trueHeading", "magneticHeading", "compassHeading", "groundspeed", "estimatedTimeEnroute", "fuel"].includes(field);
const isHeadingField = (field: NavlogInspectionField): boolean => ["windCorrectionAngle", "trueHeading", "magneticHeading", "compassHeading"].includes(field);

function traceComponent(traces: RecordValue | undefined, name: string): RecordValue | undefined {
  const values = nested(traces, "windTriangle")?.intermediateValues;
  return Array.isArray(values) ? values.find((item: unknown) => record(item) && item.name === name) as RecordValue | undefined : undefined;
}

function appendWindSteps(steps: Array<[string, string]>, row: RecordValue, subleg: RecordValue | undefined, traces: RecordValue | undefined, includeGroundspeed: boolean): void {
  const wind = nested(nested(row, "effectiveWind")?.wind, "effectiveValue");
  steps.push(["True course and airspeed", `Course ${stepValue(subleg?.trueCourse)}° true; true airspeed ${stepValue(nested(row, "trueAirspeed")?.effectiveValue)} kt${overrideNote(row, "true-airspeed")}.`]);
  steps.push(["Effective wind", `${stepValue(wind)} at this row's planned altitude and time${overrideNote(row, "effective-wind")}.`]);
  const along = traceComponent(traces, "wind along-track component");
  const cross = traceComponent(traces, "wind right-of-track component");
  const air = traceComponent(traces, "airspeed along-track component");
  if (record(along) && record(cross) && record(air)) steps.push(["Wind components", `Along track ${stepValue(along.value)} kt; right of track ${stepValue(cross.value)} kt; airspeed along track ${stepValue(air.value)} kt.`]);
  if (!includeGroundspeed) return;
  steps.push(["Wind correction and true heading", `${windCorrectionCalculation(row, traces)}; true heading is ${stepValue(row.trueHeading)}°.`]);
  steps.push(["Groundspeed", record(along) && record(air)
    ? `${stepValue(along.value)} kt wind along track + ${stepValue(air.value)} kt airspeed along track ≈ ${stepValue(row.groundspeed)} kt.`
    : `The stored wind-triangle result is ${stepValue(row.groundspeed)} kt; its component arithmetic is available in the technical trace.`]);
}

function appendHeadingSteps(steps: Array<[string, string]>, row: RecordValue, subleg: RecordValue | undefined, field: NavlogInspectionField): void {
  steps.push(["Wind correction", windCorrectionCalculation(row, nested(row, "traces"))]);
  steps.push(["True heading", `${stepValue(subleg?.trueCourse)}° true course plus ${stepValue(row.windCorrectionAngle)}° correction, normalized to approximately ${stepValue(row.trueHeading)}° true.`]);
  if (field === "magneticHeading" || field === "compassHeading") {
    const variation = nested(row, "variation")?.effectiveValue;
    steps.push(["Magnetic heading", `${stepValue(row.trueHeading)}° true heading ${signedHeadingOperation(variation, "variation")} ≈ ${stepValue(row.magneticHeading)}° magnetic${overrideNote(row, "magnetic-variation")}.`]);
  }
  if (field === "compassHeading") steps.push(["Compass heading", `${stepValue(row.magneticHeading)}° magnetic heading ${signedHeadingOperation(row.compassDeviation, "deviation")} ≈ ${stepValue(row.compassHeading)}° compass.`]);
}

function windCorrectionCalculation(row: RecordValue, traces: RecordValue | undefined): string {
  const right = traceComponent(traces, "wind right-of-track component");
  const tas = nested(row, "trueAirspeed")?.effectiveValue;
  if (!record(right) || typeof right.value !== "number" || typeof tas !== "number" || typeof row.windCorrectionAngle !== "number") {
    return `The stored wind-triangle result is ${stepValue(row.windCorrectionAngle)}°`;
  }
  const side = right.value > 0 ? "right" : right.value < 0 ? "left" : "no crosswind";
  const direction = row.windCorrectionAngle < 0 ? "left" : row.windCorrectionAngle > 0 ? "right" : "no correction";
  return `${stepValue(Math.abs(right.value))} kt crosswind from the ${side} ÷ ${stepValue(tas)} kt TAS; arcsin(${stepValue(Math.abs(right.value))} ÷ ${stepValue(tas)}) ≈ ${stepValue(Math.abs(row.windCorrectionAngle))}° ${direction}`;
}

function signedHeadingOperation(value: unknown, label: string): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return `applying unavailable east-positive ${label}`;
  return value < 0 ? `add ${stepValue(Math.abs(value))}° for west ${label}` : `subtract ${stepValue(value)}° for east ${label}`;
}

function appendSourceValueStep(steps: Array<[string, string]>, row: RecordValue, subleg: RecordValue | undefined, field: NavlogInspectionField): void {
  if (["altitude", "trueCourse", "distance"].includes(field)) appendRouteSourceStep(steps, subleg, field);
  else appendNavigationSourceStep(steps, row, field);
}

function appendRouteSourceStep(steps: Array<[string, string]>, subleg: RecordValue | undefined, field: NavlogInspectionField): void {
  if (field === "altitude") steps.push(["Altitude", `${stepValue(subleg?.startingAltitude)} ft to ${stepValue(subleg?.endingAltitude)} ft MSL from this row's route/phase allocation.`]);
  else if (field === "trueCourse") steps.push(["True course", `${stepValue(subleg?.trueCourse)}° is the course allocated to this route/phase row.`]);
  else if (field === "distance") steps.push(["Distance", `${stepValue(subleg?.distance)} NM is the distance allocated to this route/phase row.`]);
}

function appendNavigationSourceStep(steps: Array<[string, string]>, row: RecordValue, field: NavlogInspectionField): void {
  if (field === "wind") steps.push(["Effective wind", `${stepValue(nested(nested(row, "effectiveWind")?.wind, "effectiveValue"))} is the resolved wind for this row; source and interpolation evidence are in technical details.`]);
  else if (field === "variation") steps.push(["Magnetic variation", `${signedStepCompassEffect(nested(row, "variation")?.effectiveValue)} is the row's east-positive variation input.`]);
  else if (field === "compassDeviation") steps.push(["Compass deviation", `${signedStepCompassEffect(row.compassDeviation)} is selected from the aircraft deviation table at ${stepValue(row.magneticHeading)}° magnetic.`]);
}

function appendTimeFuelSteps(steps: Array<[string, string]>, row: RecordValue, subleg: RecordValue | undefined, field: NavlogInspectionField): void {
  steps.push(["Time enroute", `${stepValue(subleg?.distance)} NM ÷ ${stepValue(row.groundspeed)} kt × 60 ≈ ${stepValue(row.estimatedTimeEnroute)} min.`]);
  if (field === "fuel") steps.push(["Fuel consumed", `${stepValue(row.estimatedTimeEnroute)} min ÷ 60 × ${stepValue(nested(row, "fuelFlow")?.effectiveValue)} gal/hr ≈ ${stepValue(row.fuel)} gal for this row${overrideNote(row, "fuel-flow")}.`]);
}

function overrideNote(row: RecordValue, input: string): string {
  if (!Array.isArray(row.appliedOverrides)) return "";
  const override = row.appliedOverrides.find((candidate: unknown) => record(candidate) && candidate.input === input);
  if (!record(override)) return "";
  return `; pilot override uses ${stepValue(override.effectiveValue)}${typeof override.reason === "string" ? ` (${override.reason})` : ""}`;
}

function signedStepCompassEffect(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return `${stepValue(value)}° east-positive`;
  return value < 0 ? `${stepValue(Math.abs(value))}° west (east-positive value ${stepValue(value)}°)` : `${stepValue(value)}° east (east-positive)`;
}

function stepValue(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(Number(value.toFixed(3)));
  if (record(value) && typeof value.directionFrom === "number" && typeof value.speed === "number") {
    return `${stepValue(value.directionFrom)}° from at ${stepValue(value.speed)} kt`;
  }
  if (typeof value === "string" || typeof value === "boolean") return String(value);
  return "unavailable";
}

function worksheetValue(value: unknown, field: NavlogInspectionField, row: RecordValue): string {
  if (field === "altitude") return worksheetAltitude(row);
  if (field === "wind") return worksheetWind(value);
  return worksheetScalar(value, field);
}

function worksheetAltitude(row: RecordValue): string {
  const subleg = nested(row, "subleg");
  return `${worksheetNumber(subleg?.startingAltitude)} → ${worksheetNumber(subleg?.endingAltitude)}`;
}

function worksheetWind(value: unknown): string {
  if (!record(value) || typeof value.directionFrom !== "number" || typeof value.speed !== "number") return displayValue(value);
  return `${worksheetNumber(value.directionFrom)}° / ${worksheetNumber(value.speed)} kt`;
}

function worksheetScalar(value: unknown, field: NavlogInspectionField): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return displayValue(value);
  if (field === "fuel" && value !== 0 && Math.abs(value) < 0.1) return `${value < 0 ? "−" : ""}<0.1`;
  return worksheetNumber(value);
}

function worksheetNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(1) : "—";
}

function selectedUnit(field: NavlogInspectionField): string {
  if (field === "altitude") return "ft MSL";
  if (field === "wind") return "";
  if (field === "distance") return "NM";
  if (field === "groundspeed") return "kt";
  if (field === "estimatedTimeEnroute") return "min";
  if (field === "fuel") return "gal";
  return "°";
}

function worksheetResult(value: unknown, field: NavlogInspectionField, row: RecordValue): string {
  const displayed = worksheetValue(value, field, row);
  const unit = selectedUnit(field);
  if (unit === "°") return `${displayed}°`;
  return unit === "" ? displayed : `${displayed} ${unit}`;
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
