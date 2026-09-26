import { ICAO_PATTERN, type TafAnswer, type TafWindGroup } from './contracts';
import { ApiError } from './errors';
import { readBoundedText } from './bounded-text';

const ORIGIN = 'https://aviationweather.gov';
const MAX_BYTES = 128 * 1024;
const TIMEOUT_MS = 5_000;
const MAX_VALIDITY_SECONDS = 30 * 60 * 60;
const MAX_TAF_AGE_MS = 31 * 60 * 60 * 1_000;
const MAX_TAF_HORIZON_MS = 31 * 60 * 60 * 1_000;
export interface TafFetcher { fetch(request: Request): Promise<Response>; }
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value);
const timestamp = (ms: number): string => new Date(ms).toISOString();
function fail(): never { throw new ApiError('Aviation Weather Center returned an invalid or unsupported TAF.', 502, 'upstream_invalid_response'); }
function integerOrNull(value: unknown, maximum: number): boolean { return value === null || Number.isInteger(value) && (value as number) >= 0 && (value as number) <= maximum; }
function validGroupWind(direction: unknown, speed: unknown, gust: unknown): boolean {
  const validDirection = direction === null || direction === 'VRB' || integerOrNull(direction, 360);
  const coherent = direction === null ? speed === null : speed !== null;
  return validDirection && integerOrNull(speed, 199) && integerOrNull(gust, 199) && (gust === null || speed !== null) && coherent;
}
function groupProbability(kind: TafWindGroup['kind'], probability: unknown): boolean { return kind === 'PROB' ? probability === 30 || probability === 40 : probability === null || probability === undefined; }
function normalizedWind(direction: unknown, speed: unknown): Pick<TafWindGroup, 'windDirectionType' | 'windFromDegTrue' | 'windSpeedKt'> {
  if (direction === 'VRB') return { windDirectionType: 'variable', windFromDegTrue: null, windSpeedKt: speed as number };
  if (direction === null) return { windDirectionType: 'missing', windFromDegTrue: null, windSpeedKt: null };
  return { windDirectionType: 'fixed', windFromDegTrue: direction as number, windSpeedKt: speed as number };
}

function normalizeGroup(value: unknown, kind: TafWindGroup['kind'], from: number, until: number, raw: string): TafWindGroup {
  if (!isValidGroupRecord(value, from, until, raw) || until - from > MAX_VALIDITY_SECONDS) return fail();
  const direction = value.wdir ?? null;
  const speed = value.wspd ?? null;
  const gust = value.wgst ?? null;
  const probability = value.probability;
  if (!validGroupWind(direction, speed, gust) || !groupProbability(kind, probability)) return fail();
  const fromUtc = timestamp(from * 1000);
  const untilUtc = timestamp(until * 1000);
  return { kind, fromUtc, untilUtc, ...normalizedWind(direction, speed), gustKt: gust as number | null, probabilityPercent: kind === 'PROB' ? probability as number : null, raw };
}

function isValidGroupRecord(value: unknown, from: number, until: number, raw: string): value is RecordValue {
  return record(value) && Number.isSafeInteger(from) && Number.isSafeInteger(until) && until > from && typeof raw === 'string' && raw.length <= 4096;
}

function groupKind(label: unknown): TafWindGroup['kind'] | null { return label === null || label === undefined || label === '' ? 'prevailing' : label === 'FM' ? 'FM' : label === 'TEMPO' ? 'TEMPO' : label === 'PROB' || label === 'PROB30' || label === 'PROB40' ? 'PROB' : null; }
function currentReport(payload: unknown, icao: string): RecordValue {
  if (!Array.isArray(payload) || payload.length === 0 || payload.length > 8) throw new ApiError('No current TAF is available for this station.', 404, 'upstream_no_data');
  const reports = payload.filter(record).filter((r) => r.icaoId === icao && r.mostRecent === 1);
  if (reports.length !== 1) return fail();
  return reports[0]!;
}
function probabilityForGroup(item: RecordValue): number | null {
  const labelProbability = item.fcstChange === 'PROB30' ? 30 : item.fcstChange === 'PROB40' ? 40 : null;
  const probability = item.probability ?? labelProbability;
  if (probability !== 30 && probability !== 40) return null;
  if (labelProbability !== null && probability !== labelProbability) return null;
  return probability;
}
function prepareGroup(item: unknown, report: RecordValue): { kind: TafWindGroup['kind']; value: RecordValue; raw: string } | null {
  if (!record(item)) return null;
  const kind = groupKind(item.fcstChange);
  if (!kind) return null;
  const probability = kind === 'PROB' ? probabilityForGroup(item) : null;
  if (kind === 'PROB' && probability === null) return null;
  if (kind !== 'PROB' && item.probability !== null && item.probability !== undefined) return null;
  const raw = typeof item.rawTAF === 'string' ? item.rawTAF : typeof item.raw === 'string' ? item.raw : report.rawTAF as string;
  const normalizedItem = kind === 'PROB' ? { ...item, probability } : item;
  return { kind, value: normalizedItem, raw };
}
function normalizeOneGroup(item: unknown, report: RecordValue, start: number, end: number): TafWindGroup {
  const prepared = prepareGroup(item, report);
  if (!prepared) return fail();
  const source = item as RecordValue;
  const from = source.timeFrom as number, until = source.timeTo as number;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(until) || from < start || until > end) return fail();
  const group = normalizeGroup(prepared.value, prepared.kind, from, until, prepared.raw);
  if (Date.parse(group.fromUtc) < start * 1000 || Date.parse(group.untilUtc) > end * 1000) return fail();
  return group;
}
function normalizeGroups(report: RecordValue, start: number, end: number): TafWindGroup[] {
  if (!Array.isArray(report.fcsts) || report.fcsts.length < 1 || report.fcsts.length > 100) return fail();
  const groups = report.fcsts.map((item) => normalizeOneGroup(item, report, start, end));
  if (groups.filter((g) => g.kind === 'prevailing').length !== 1) return fail();
  return groups;
}
interface ReportTimes { issuedAt: number; start: number; end: number; raw: string; }
function validReportWindow(start: unknown, end: unknown, now: number): start is number {
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && (end as number) > (start as number) && (end as number) - (start as number) <= MAX_VALIDITY_SECONDS && (start as number) * 1000 >= now - MAX_TAF_AGE_MS && (end as number) * 1000 <= now + MAX_TAF_HORIZON_MS;
}
function reportTimes(report: RecordValue, now: number): ReportTimes | null {
  const issuedAt = typeof report.issueTime === 'string' ? Date.parse(report.issueTime) : NaN;
  const validFrom = report.validTimeFrom, validUntil = report.validTimeTo;
  if (!Number.isFinite(issuedAt) || issuedAt > now || now - issuedAt > MAX_TAF_AGE_MS || !validReportWindow(validFrom, validUntil, now) || typeof report.rawTAF !== 'string' || report.rawTAF.length > 4096) return null;
  return { issuedAt, start: validFrom as number, end: validUntil as number, raw: report.rawTAF };
}
function normalizeReport(payload: unknown, icao: string, now: number): Omit<TafAnswer, 'requestId'> {
  const report = currentReport(payload, icao);
  const times = reportTimes(report, now);
  if (!times) return fail();
  const { issuedAt, start, end, raw } = times;
  if (Date.parse(timestamp(now)) >= end * 1000) throw new ApiError('No current TAF is available for this station.', 404, 'upstream_no_data');
  const groups = normalizeGroups(report, start, end);
  return { stationIcao: icao, issuedAt: timestamp(issuedAt), validFrom: timestamp(start * 1000), validUntil: timestamp(end * 1000), rawTaf: raw, groups };
}

export function createTafAdapter(fetcher: TafFetcher, now: () => Date = () => new Date()): { getTaf(icao: string): Promise<Omit<TafAnswer, 'requestId'>> } {
  return { async getTaf(icao) {
    if (!ICAO_PATTERN.test(icao)) throw new ApiError('Invalid ICAO code.', 400, 'invalid_request');
    const url = new URL('/api/data/taf', ORIGIN);
    url.searchParams.set('ids', icao); url.searchParams.set('format', 'json');
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetcher.fetch(new Request(url, { signal: controller.signal, headers: { Accept: 'application/json' } }));
      if (response.status === 204) throw new ApiError('No current TAF is available for this station.', 404, 'upstream_no_data');
      if (!response.ok) throw new ApiError('Aviation Weather Center is unavailable.', 503, 'upstream_unavailable');
      let body: string;
      try { body = await readBoundedText(response, MAX_BYTES); } catch { return fail(); }
      let json: unknown; try { json = JSON.parse(body) as unknown; } catch { return fail(); }
      return normalizeReport(json, icao, now().getTime());
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError('Aviation Weather Center is unavailable.', 503, 'upstream_unavailable');
    } finally { clearTimeout(timeout); }
  } };
}
