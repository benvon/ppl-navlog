import { describe, expect, it } from 'vitest';
import { fetchWeatherResource, UpstreamFailure } from './upstream';

const stamp = 1_800_000_000_000;
const response = (status: number, body = 'bad') => new Response(body, { status });
describe('bounded allowlisted upstream reads', () => {
  it('upstream_paths_are_allowlisted', async () => {
    const urls: string[] = [];
    const fetcher = { fetch: async (request: Request) => { urls.push(request.url); return response(502); } };
    const keys = ['winds:us:06','winds:us:12','winds:us:24','winds:alaska:06','winds:alaska:12','winds:alaska:24','winds:hawaii:06','winds:hawaii:12','winds:hawaii:24','station-catalog:v1'] as const;
    for (const key of keys) await expect(fetchWeatherResource(key, fetcher, undefined, () => stamp)).rejects.toThrow();
    expect(urls).toHaveLength(10);
    for (const value of urls) { const url = new URL(value); expect(url.origin).toBe('https://aviationweather.gov'); expect(url.pathname).toMatch(/^\/(api\/data\/windtemp|data\/cache\/stations\.cache\.json\.gz)$/); }
    expect(new URL(urls[0]!).searchParams.get('fcst')).toBe('06');
  });
  it('redirect_and_oversized_or_invalid_body_consume_attempt', async () => {
    await expect(fetchWeatherResource('winds:us:06', { fetch: async () => response(302) })).rejects.toThrow(/redirect/);
    await expect(fetchWeatherResource('winds:us:06', { fetch: async () => new Response(new Uint8Array(1024 * 1024 + 1)) })).rejects.toThrow(/size limit/);
    let invalidClockCalls = 0;
    await expect(fetchWeatherResource('station-catalog:v1', { fetch: async () => response(200, 'not gzip') }, undefined, () => { invalidClockCalls += 1; return stamp; })).rejects.toThrow();
    expect(invalidClockCalls).toBe(0);
    await expect(fetchWeatherResource('winds:us:06', { fetch: async () => new Response(null, { status: 204 }) })).rejects.toThrow(/No weather data/);
    await expect(fetchWeatherResource('station-catalog:v1', { fetch: async () => new Response(new Uint8Array(3 * 1024 * 1024 + 1)) })).rejects.toThrow(/size limit/);
    const bomb = new Blob([' '.repeat(3 * 1024 * 1024 + 1)]).stream().pipeThrough(new CompressionStream('gzip'));
    await expect(fetchWeatherResource('station-catalog:v1', { fetch: async () => new Response(bomb) })).rejects.toThrow(/size limit/);
  });
  it('five_second_deadline_covers_fetch_and_body_reads', async () => {
    await expect(fetchWeatherResource('winds:us:06', { fetch: () => new Promise<Response>(() => undefined) })).rejects.toThrow(/timed out/);
    const stream = new ReadableStream<Uint8Array>({ start() { /* Deliberately stalls after response headers. */ } });
    await expect(fetchWeatherResource('winds:us:06', { fetch: async () => new Response(stream) })).rejects.toThrow(/timed out/);
  }, 12_000);
  it('preserves_provider_retry_metadata', async () => {
    try { await fetchWeatherResource('station-catalog:v1', { fetch: async () => new Response('busy', { status: 429, headers: { 'Retry-After': '3600' } }) }); throw new Error('Expected rejection.'); }
    catch (error) { expect(error).toBeInstanceOf(UpstreamFailure); expect((error as UpstreamFailure).status).toBe(429); expect((error as UpstreamFailure).retryAfter).toBe('3600'); }
    const hostile = new ReadableStream<Uint8Array>({ start() { /* No body read is needed on 429. */ }, cancel() { return new Promise<void>(() => undefined); } });
    await expect(fetchWeatherResource('station-catalog:v1', { fetch: async () => new Response(hostile, { status: 429, headers: { 'Retry-After': '120' } }) })).rejects.toThrow();
  });

  it('validates_and_stamps_a_gzip_catalog', async () => {
    const json = JSON.stringify([{ iataId: 'ABQ', site: 'Albuquerque', lat: 35.04, lon: -106.61, elev: 5355 }]);
    const compressed = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
    let captured: Request | undefined;
    const resource = await fetchWeatherResource('station-catalog:v1', { fetch: async (request) => { captured = request; return new Response(compressed); } }, undefined, () => stamp + 250);
    expect(resource.kind).toBe('catalog');
    if (resource.kind !== 'catalog') throw new Error('Expected catalog.');
    expect(resource.entries[0]?.iataId).toBe('ABQ');
    expect(resource.metadata.checkedAt).toBe(new Date(stamp + 250).toISOString());
    expect(captured?.redirect).toBe('manual');
    expect(captured?.headers.get('User-Agent')).toContain('ppl-navlog/0.1');
  });


  it('timeout_does_not_wait_for_a_hostile_reader_cancel', async () => {
    const stream = new ReadableStream<Uint8Array>({ start() { /* Never emits data. */ }, cancel() { return new Promise<void>(() => undefined); } });
    const started = Date.now();
    await expect(fetchWeatherResource('winds:us:06', { fetch: async () => new Response(stream) }, undefined, () => stamp)).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(5_800);
  }, 7_000);

});
