import { describe, expect, it, vi } from 'vitest';
import { createTafAdapter } from './taf';

const FIXED = new Date('2026-09-22T00:00:00.000Z');
const apiGroup = (fcstChange: string | null, timeFrom: number, timeTo: number, wdir: number | 'VRB' | null, wspd: number | null, extra: Record<string, unknown> = {}) => ({ fcstChange, timeFrom, timeTo, wdir, wspd, wgst: null, raw: `${fcstChange ?? 'prevailing'} source`, ...extra });
const body = (overrides: Record<string, unknown> = {}) => [{ icaoId: 'KORD', issueTime: '2026-09-22T00:00:00.000Z', validTimeFrom: 1790035200, validTimeTo: 1790121600, mostRecent: 1, rawTAF: 'TAF KORD fixture', fcsts: [apiGroup(null, 1790035200, 1790121600, 270, 10), apiGroup('FM', 1790042400, 1790121600, 280, 12), apiGroup('TEMPO', 1790042400, 1790049600, 'VRB', 8), apiGroup('PROB', 1790042400, 1790049600, null, null, { probability: 30 })], ...overrides }];
const adapterFor = (data: unknown, status = 200) => {
  const requests: Request[] = [];
  const adapter = createTafAdapter({ fetch: async (request) => { requests.push(request); return Response.json(data, { status }); } }, () => FIXED);
  return { adapter, requests };
};

describe('AWC TAF adapter', () => {
  it('requests the fixed AWC endpoint, normalizes API epoch groups, amendment issue time, and VRB explicitly', async () => {
    const { adapter, requests } = adapterFor(body());
    const result = await adapter.getTaf('KORD');
    expect(new URL(requests[0]!.url).origin).toBe('https://aviationweather.gov');
    expect(new URL(requests[0]!.url).pathname).toBe('/api/data/taf');
    expect(result.groups.map((group) => group.kind)).toEqual(['prevailing', 'FM', 'TEMPO', 'PROB']);
    expect(result.groups[2]).toMatchObject({ windDirectionType: 'variable', windFromDegTrue: null, windSpeedKt: 8 });
    expect(result.groups[3]).toMatchObject({ probabilityPercent: 30, windDirectionType: 'missing', windFromDegTrue: null, windSpeedKt: null });
  });

  it('normalizes omitted conditional wind elements as missing rather than variable', async () => {
    const report = body();
    (report[0]!.fcsts as Record<string, unknown>[]).push({ fcstChange: 'TEMPO', timeFrom: 1790042400, timeTo: 1790049600, raw: 'TEMPO omitted wind' });
    const result = await adapterFor(report).adapter.getTaf('KORD');
    expect(result.groups.at(-1)).toMatchObject({ windDirectionType: 'missing', windFromDegTrue: null, windSpeedKt: null });
  });

  it('preserves 30 and 40 percent PROB groups from both raw labels and structured AWC data', async () => {
    const report = body();
    (report[0]!.fcsts as Record<string, unknown>[]).push(
      apiGroup('PROB40', 1790042400, 1790049600, null, null),
      apiGroup('PROB', 1790042400, 1790049600, null, null, { probability: 40 }),
    );
    const result = await adapterFor(report).adapter.getTaf('KORD');
    expect(result.groups.slice(-2).map((group) => group.probabilityPercent)).toEqual([40, 40]);
    expect(result.groups[3]?.probabilityPercent).toBe(30);
  });

  it('rejects unsupported or contradictory PROB percentages', async () => {
    const unsupported = body();
    (unsupported[0]!.fcsts as Record<string, unknown>[]).push(apiGroup('PROB', 1790042400, 1790049600, null, null, { probability: 50 }));
    await expect(adapterFor(unsupported).adapter.getTaf('KORD')).rejects.toMatchObject({ code: 'upstream_invalid_response' });
    const contradictory = body();
    (contradictory[0]!.fcsts as Record<string, unknown>[]).push(apiGroup('PROB40', 1790042400, 1790049600, null, null, { probability: 30 }));
    await expect(adapterFor(contradictory).adapter.getTaf('KORD')).rejects.toMatchObject({ code: 'upstream_invalid_response' });
  });

  it('rejects wrong station, non-most-recent/superseded reports, future issue, and malformed periods', async () => {
    await expect(adapterFor([{ ...body()[0], icaoId: 'KJFK' }]).adapter.getTaf('KORD')).rejects.toMatchObject({ code: 'upstream_invalid_response' });
    await expect(adapterFor([{ ...body()[0], mostRecent: 0 }]).adapter.getTaf('KORD')).rejects.toMatchObject({ code: 'upstream_invalid_response' });
    await expect(adapterFor([{ ...body()[0], issueTime: '2026-09-22T00:01:00.000Z' }]).adapter.getTaf('KORD')).rejects.toMatchObject({ code: 'upstream_invalid_response' });
    const malformed = body();
    (malformed[0]!.fcsts as Record<string, unknown>[])[0]!.timeTo = 1;
    await expect(adapterFor(malformed).adapter.getTaf('KORD')).rejects.toMatchObject({ code: 'upstream_invalid_response' });
    await expect(adapterFor([{ ...body()[0], validTimeFrom: Number.MAX_SAFE_INTEGER }]).adapter.getTaf('KORD')).rejects.toMatchObject({ code: 'upstream_invalid_response' });
    await expect(adapterFor([{ ...body()[0], validTimeTo: 1790146800 }]).adapter.getTaf('KORD')).rejects.toMatchObject({ code: 'upstream_invalid_response' });
    await expect(adapterFor([{ ...body()[0], issueTime: '2026-09-20T00:00:00.000Z' }]).adapter.getTaf('KORD')).rejects.toMatchObject({ code: 'upstream_invalid_response' });
  });

  it('rejects a group epoch outside safe integer bounds before date conversion', async () => {
    const invalid = body();
    (invalid[0]!.fcsts as Record<string, unknown>[])[0]!.timeFrom = 9007199254740990;
    (invalid[0]!.fcsts as Record<string, unknown>[])[0]!.timeTo = 9007199254740991;
    await expect(adapterFor(invalid).adapter.getTaf('KORD')).rejects.toMatchObject({ code: 'upstream_invalid_response' });
  });

  it('uses the latest amendment immediately even when its validity begins in the future', async () => {
    const prior = { ...body()[0]!, issueTime: '2026-09-21T18:00:00.000Z', mostRecent: 0 };
    const amendment = { ...body()[0]!, issueTime: '2026-09-22T00:00:00.000Z', validTimeFrom: 1790042400, mostRecent: 1, fcsts: (body()[0]!.fcsts as Record<string, unknown>[]).map((group, index) => index === 0 ? { ...group, timeFrom: 1790042400 } : group) };
    const answer = await adapterFor([prior, amendment]).adapter.getTaf('KORD');
    expect(answer.issuedAt).toBe('2026-09-22T00:00:00.000Z');
    expect(answer.validFrom).toBe('2026-09-22T02:00:00.000Z');
  });

  it('bounds bytes, aborts timed out requests, and distinguishes no TAF', async () => {
    const oversized = createTafAdapter({ fetch: async () => new Response('x'.repeat(128 * 1024 + 1)) }, () => FIXED);
    await expect(oversized.getTaf('KORD')).rejects.toMatchObject({ code: 'upstream_invalid_response' });
    vi.useFakeTimers();
    const timed = createTafAdapter({ fetch: (request) => new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')))) }, () => FIXED);
    const pending = timed.getTaf('KORD');
    const observed = expect(pending).rejects.toMatchObject({ code: 'upstream_unavailable' });
    await vi.advanceTimersByTimeAsync(5001);
    await observed;
    vi.useRealTimers();
    await expect(adapterFor([]).adapter.getTaf('KORD')).rejects.toMatchObject({ code: 'upstream_no_data' });
    await expect(createTafAdapter({ fetch: async () => new Response(null, { status: 204 }) }, () => FIXED).getTaf('KORD')).rejects.toMatchObject({ code: 'upstream_no_data' });
    const stale = body();
    (stale[0]!.validTimeFrom as number) = 1790031600;
    (stale[0]!.validTimeTo as number) = 1790034000;
    await expect(adapterFor(stale).adapter.getTaf('KORD')).rejects.toMatchObject({ code: 'upstream_no_data' });
  });
});
