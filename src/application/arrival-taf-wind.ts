import { solveWindTriangle } from '../domain/wind-triangle';
import { knots, trueCourse } from '../domain/units';
import { wind } from '../domain/wind';
import type { TafAnswer, TafWindGroup } from '../../worker/api/contracts';

export interface ArrivalWindCandidate { group: TafWindGroup; inheritedWindGroup: TafWindGroup | null; sourceWind: { directionType: TafWindGroup['windDirectionType']; directionFromDegTrue: number | null; speedKt: number | null; gustKt: number | null }; effectiveWind: { directionFromDegTrue: number; speedKt: number }; groundspeedKt: number; directionAssumption: 'VRB treated as direct headwind' | null; }
export interface SelectedArrivalTafWind { selectedGroup: TafWindGroup; selectedCandidate: ArrivalWindCandidate; effectiveWind: ArrivalWindCandidate['effectiveWind']; groundspeedKt: number; candidates: ArrivalWindCandidate[]; surfaceToPatternAssumption: string; source: 'taf'; }
export interface SelectedArrivalMetarWind { stationIcao: string; requestId: string; reportSource: 'aviationweather'; fetchedAt: string; observedAt: string; raw: string; cacheProvenance: { status: string; source: string; freshnessRemainingSeconds: number; fetchedAt: string; expiresAt: string }; effectiveWind: { directionFromDegTrue: number; speedKt: number }; groundspeedKt: number; surfaceToPatternAssumption: string; source: 'metar'; }
export type SelectedArrivalWind = SelectedArrivalTafWind | SelectedArrivalMetarWind;
export class ArrivalTafError extends Error { constructor(message: string) { super(message); this.name = 'ArrivalTafError'; } }
const surfaceAssumption = 'TAF surface wind is used as a proxy for wind from the surface to the traffic pattern; no runway or crosswind is selected.';
const metarSurfaceAssumption = 'Destination METAR wind is used as a proxy for wind from the surface to the traffic pattern; no runway or crosswind is selected.';

function sameGroup(a: TafWindGroup, b: TafWindGroup): boolean {
  return a.kind === b.kind && a.fromUtc === b.fromUtc && a.untilUtc === b.untilUtc && a.windDirectionType === b.windDirectionType && a.windFromDegTrue === b.windFromDegTrue && a.windSpeedKt === b.windSpeedKt && a.gustKt === b.gustKt && a.probabilityPercent === b.probabilityPercent && a.raw === b.raw;
}

function sameCandidate(a: ArrivalWindCandidate, b: ArrivalWindCandidate): boolean {
  const inheritedSame = a.inheritedWindGroup === null ? b.inheritedWindGroup === null : b.inheritedWindGroup !== null && sameGroup(a.inheritedWindGroup, b.inheritedWindGroup);
  return sameGroup(a.group, b.group) && inheritedSame && a.sourceWind.directionType === b.sourceWind.directionType && a.sourceWind.directionFromDegTrue === b.sourceWind.directionFromDegTrue && a.sourceWind.speedKt === b.sourceWind.speedKt && a.sourceWind.gustKt === b.sourceWind.gustKt && a.effectiveWind.directionFromDegTrue === b.effectiveWind.directionFromDegTrue && a.effectiveWind.speedKt === b.effectiveWind.speedKt && a.groundspeedKt === b.groundspeedKt && a.directionAssumption === b.directionAssumption;
}

export function arrivalTafWindSelectionChanged(a: SelectedArrivalWind, b: SelectedArrivalWind): boolean {
  if (a.source !== b.source) return true;
  if (a.source === 'metar' && b.source === 'metar') return metarSelectionChanged(a, b);
  if (a.source === 'metar' || b.source === 'metar') return true;
  return !sameGroup(a.selectedGroup, b.selectedGroup) || !sameCandidate(a.selectedCandidate, b.selectedCandidate) || a.effectiveWind.directionFromDegTrue !== b.effectiveWind.directionFromDegTrue || a.effectiveWind.speedKt !== b.effectiveWind.speedKt || a.groundspeedKt !== b.groundspeedKt;
}
function metarSelectionChanged(a: SelectedArrivalMetarWind, b: SelectedArrivalMetarWind): boolean {
  return a.stationIcao !== b.stationIcao || a.requestId !== b.requestId || a.observedAt !== b.observedAt || a.raw !== b.raw || a.effectiveWind.directionFromDegTrue !== b.effectiveWind.directionFromDegTrue || a.effectiveWind.speedKt !== b.effectiveWind.speedKt || a.groundspeedKt !== b.groundspeedKt;
}

function candidateFor(group: TafWindGroup, base: TafWindGroup, courseDeg: number, tasKt: number): ArrivalWindCandidate {
  const direction = group.windDirectionType === 'variable' ? null : group.windDirectionType === 'missing' ? base.windFromDegTrue : group.windFromDegTrue;
  const speed = group.windSpeedKt ?? base.windSpeedKt;
  if (speed === null) throw new ArrivalTafError('TAF arrival wind is unavailable.');
  const variable = group.windDirectionType === 'variable' || group.windDirectionType === 'missing' && base.windDirectionType === 'variable';
  const assumedDirection = variable ? courseDeg : direction;
  if (assumedDirection === null) throw new ArrivalTafError('TAF wind direction is unavailable.');
  const groundspeedKt = groundspeedFor(assumedDirection, speed, courseDeg, tasKt);
  return { group, inheritedWindGroup: group.windDirectionType === 'missing' ? base : null, sourceWind: { directionType: group.windDirectionType, directionFromDegTrue: group.windFromDegTrue, speedKt: group.windSpeedKt, gustKt: group.gustKt }, effectiveWind: { directionFromDegTrue: assumedDirection, speedKt: speed }, groundspeedKt, directionAssumption: variable ? 'VRB treated as direct headwind' : null };
}
function groundspeedFor(direction: number, speed: number, courseDeg: number, tasKt: number): number {
  const course = trueCourse(courseDeg), tas = knots(tasKt), effective = wind(direction, speed);
  if (!course.ok || !tas.ok || !effective.ok) throw new ArrivalTafError('TAF wind inputs are outside supported bounds.');
  const result = solveWindTriangle(course.value, tas.value, effective.value);
  if (!result.ok) throw new ArrivalTafError('TAF wind cannot produce a valid groundspeed.');
  return result.value.groundspeed;
}
function arrivalWindow(taf: TafAnswer, arrivalUtc: string): number {
  const at = Date.parse(arrivalUtc), issued = Date.parse(taf.issuedAt), from = Date.parse(taf.validFrom), until = Date.parse(taf.validUntil);
  if (![at, issued, from, until].every(Number.isFinite) || issued > at || at < from || at >= until) throw new ArrivalTafError('Arrival time is outside the current TAF issuance or validity period.');
  if (!taf.groups.every((g) => { const start = Date.parse(g.fromUtc), end = Date.parse(g.untilUtc); return Number.isFinite(start) && Number.isFinite(end) && start < end && start >= from && end <= until; })) throw new ArrivalTafError('TAF group timing is invalid.');
  return at;
}
function arrivalBase(groups: TafWindGroup[]): TafWindGroup {
  const bases = groups.filter((g) => g.kind === 'prevailing' || g.kind === 'FM').sort((a, b) => Date.parse(b.fromUtc) - Date.parse(a.fromUtc));
  if (bases.length === 0) throw new ArrivalTafError('TAF has no prevailing wind coverage at arrival.');
  const latestStart = Date.parse(bases[0]!.fromUtc);
  const latest = bases.filter((g) => Date.parse(g.fromUtc) === latestStart);
  const windIdentities = new Set(latest.map((g) => `${g.windDirectionType}:${g.windFromDegTrue}:${g.windSpeedKt}:${g.gustKt}`));
  if (windIdentities.size > 1) throw new ArrivalTafError('TAF has conflicting prevailing groups with equal start times.');
  return latest.sort((a, b) => a.kind.localeCompare(b.kind) || a.raw.localeCompare(b.raw))[0]!;
}

export function selectArrivalTafWind(taf: TafAnswer, arrivalUtc: string, arrivalCourseDegTrue: number, arrivalTasKt: number): SelectedArrivalTafWind {
  const at = arrivalWindow(taf, arrivalUtc);
  if (!Number.isFinite(arrivalCourseDegTrue) || arrivalCourseDegTrue < 0 || arrivalCourseDegTrue > 360 || !Number.isFinite(arrivalTasKt) || arrivalTasKt <= 0) throw new ArrivalTafError('Arrival course or true airspeed is invalid.');
  const groups = taf.groups.filter((g) => Date.parse(g.fromUtc) <= at && at < Date.parse(g.untilUtc));
  const base = arrivalBase(groups);
  const active = groups.filter((g) => g.kind === 'TEMPO' || g.kind === 'PROB');
  const considered = active.length > 0 ? active : [base];
  const candidates = considered.map((group) => candidateFor(group, base, arrivalCourseDegTrue, arrivalTasKt));
  candidates.sort((a, b) => a.groundspeedKt - b.groundspeedKt || Date.parse(a.group.fromUtc) - Date.parse(b.group.fromUtc) || a.group.kind.localeCompare(b.group.kind));
  const selected = candidates[0]!;
  return { selectedGroup: selected.group, selectedCandidate: selected, effectiveWind: selected.effectiveWind, groundspeedKt: selected.groundspeedKt, candidates, surfaceToPatternAssumption: surfaceAssumption, source: 'taf' };
}

export function selectArrivalMetarWind(input: { readonly icao: string; readonly requestId: string; readonly reportSource: 'aviationweather'; readonly fetchedAt: string; readonly observedAt: string; readonly raw: string; readonly cacheProvenance: SelectedArrivalMetarWind['cacheProvenance']; readonly directionType: 'fixed' | 'calm'; readonly directionFromDegTrue: number | null; readonly speedKt: number }, arrivalCourseDegTrue: number, arrivalTasKt: number): SelectedArrivalMetarWind {
  validateArrivalCourseAndTas(arrivalCourseDegTrue, arrivalTasKt);
  validateMetarWind(input);
  if (!Number.isFinite(input.speedKt) || input.speedKt < 0 || input.speedKt > 199) throw new ArrivalTafError('Destination METAR wind inputs are outside supported bounds.');
  const direction = input.directionType === 'calm' ? 0 : input.directionFromDegTrue!;
  if (!Number.isFinite(Date.parse(input.observedAt))) throw new ArrivalTafError('Destination METAR observation time is invalid.');
  return { stationIcao: input.icao, requestId: input.requestId, reportSource: input.reportSource, fetchedAt: input.fetchedAt, observedAt: input.observedAt, raw: input.raw, cacheProvenance: input.cacheProvenance, effectiveWind: { directionFromDegTrue: direction, speedKt: input.speedKt }, groundspeedKt: groundspeedFor(direction, input.speedKt, arrivalCourseDegTrue, arrivalTasKt), surfaceToPatternAssumption: metarSurfaceAssumption, source: 'metar' };
}
function validateArrivalCourseAndTas(course: number, tas: number): void {
  if (!Number.isFinite(course) || course < 0 || course > 360 || !Number.isFinite(tas) || tas <= 0) throw new ArrivalTafError('Destination METAR wind inputs are outside supported bounds.');
}
function validateMetarWind(input: { readonly directionType: 'fixed' | 'calm'; readonly directionFromDegTrue: number | null }): void {
  if (input.directionType === 'fixed' && (input.directionFromDegTrue === null || !Number.isFinite(input.directionFromDegTrue) || input.directionFromDegTrue < 0 || input.directionFromDegTrue > 360)) throw new ArrivalTafError('Destination METAR wind inputs are outside supported bounds.');
}
