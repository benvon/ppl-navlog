import { solveWindTriangle } from '../domain/wind-triangle';
import { knots, trueCourse } from '../domain/units';
import { wind } from '../domain/wind';
import type { TafAnswer, TafWindGroup } from '../../worker/api/contracts';

export interface ArrivalWindCandidate { group: TafWindGroup; inheritedWindGroup: TafWindGroup | null; sourceWind: { directionType: TafWindGroup['windDirectionType']; directionFromDegTrue: number | null; speedKt: number | null; gustKt: number | null }; effectiveWind: { directionFromDegTrue: number; speedKt: number }; groundspeedKt: number; directionAssumption: 'VRB treated as direct headwind' | null; }
export interface SelectedArrivalWind { selectedGroup: TafWindGroup; effectiveWind: ArrivalWindCandidate['effectiveWind']; groundspeedKt: number; candidates: ArrivalWindCandidate[]; surfaceToPatternAssumption: string; }
export class ArrivalTafError extends Error { constructor(message: string) { super(message); this.name = 'ArrivalTafError'; } }
const surfaceAssumption = 'TAF surface wind is used as a proxy for wind from the surface to the traffic pattern; no runway or crosswind is selected.';

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

export function selectArrivalTafWind(taf: TafAnswer, arrivalUtc: string, arrivalCourseDegTrue: number, arrivalTasKt: number): SelectedArrivalWind {
  const at = arrivalWindow(taf, arrivalUtc);
  if (!Number.isFinite(arrivalCourseDegTrue) || arrivalCourseDegTrue < 0 || arrivalCourseDegTrue > 360 || !Number.isFinite(arrivalTasKt) || arrivalTasKt <= 0) throw new ArrivalTafError('Arrival course or true airspeed is invalid.');
  const groups = taf.groups.filter((g) => Date.parse(g.fromUtc) <= at && at < Date.parse(g.untilUtc));
  const base = arrivalBase(groups);
  const active = groups.filter((g) => g.kind === 'TEMPO' || g.kind === 'PROB');
  const considered = active.length > 0 ? active : [base];
  const candidates = considered.map((group) => candidateFor(group, base, arrivalCourseDegTrue, arrivalTasKt));
  candidates.sort((a, b) => a.groundspeedKt - b.groundspeedKt || Date.parse(a.group.fromUtc) - Date.parse(b.group.fromUtc) || a.group.kind.localeCompare(b.group.kind));
  const selected = candidates[0]!;
  return { selectedGroup: selected.group, effectiveWind: selected.effectiveWind, groundspeedKt: selected.groundspeedKt, candidates, surfaceToPatternAssumption: surfaceAssumption };
}
