import coordinator, { WeatherBudgetCoordinator } from './index';

/** Test-only upstream response; production bindings and routes do not include this hook. */
let upstreamCalls = 0;
let upstreamMode: 'ok' | 'blocked' | 'blocked-fail' | '429' | 'fail' | 'race' = 'ok';
let clock = Date.now();
let clockSequence: number[] = [];
let releaseFetch!: () => void;
let blockedFetch: Promise<void> | undefined;
Date.now = () => clockSequence.shift() ?? clock;
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], timeout?: number, ...args: unknown[]) => nativeSetTimeout(handler, timeout === 5_000 ? 30_000 : timeout, ...args)) as typeof setTimeout;
function isCatalogRequest(requestUrl: string): boolean { return new URL(requestUrl).pathname === '/data/cache/stations.cache.json.gz'; }
async function catalogResponse(): Promise<Response> {
  const bytes = new TextEncoder().encode(JSON.stringify([{ iataId: 'ABC', site: 'Test Station', lat: 40, lon: -100, elev: 0 }]));
  return new Response(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}
function isBlocked(mode: typeof upstreamMode, is429: boolean): boolean { return mode === 'blocked' || mode === 'blocked-fail' || (mode === 'race' && !is429); }
async function waitForRelease(): Promise<void> {
  blockedFetch ??= new Promise<void>((resolve) => { releaseFetch = resolve; });
  await blockedFetch;
}
function upstreamFailure(mode: typeof upstreamMode, is429: boolean): Response | undefined {
  if (is429) return new Response('', { status: 429, headers: { 'Retry-After': '60' } });
  if (mode === 'fail' || mode === 'blocked-fail') return new Response('', { status: 500 });
  return undefined;
}
function productResponse(requestUrl: string): Response {
  const cycle = new URL(requestUrl).searchParams.get('fcst');
  const currentDate = new Date(clock);
  const day = String(currentDate.getUTCDate()).padStart(2, '0');
  const nextDay = String(new Date(Date.UTC(currentDate.getUTCFullYear(), currentDate.getUTCMonth(), currentDate.getUTCDate() + 1)).getUTCDate()).padStart(2, '0');
  const product = cycle === '12' ? `DATA BASED ON ${day}0000Z\nVALID ${day}1200Z FOR USE 1200-1800Z\nFT 3000\nABC2700`
    : cycle === '24' ? `DATA BASED ON ${day}0000Z\nVALID ${nextDay}0000Z FOR USE 1800-0000Z\nFT 3000\nABC2700`
      : `DATA BASED ON ${day}0000Z\nVALID ${day}0600Z FOR USE 0600-1200Z\nFT 3000\nABC2700`;
  return new Response(product, { status: 200 });
}
async function mockedUpstream(requestUrl: string, mode: typeof upstreamMode): Promise<Response> {
  if (isCatalogRequest(requestUrl)) return catalogResponse();
  const is429 = mode === '429' || (mode === 'race' && new URL(requestUrl).searchParams.get('fcst') === '24');
  if (isBlocked(mode, is429)) await waitForRelease();
  const failure = upstreamFailure(mode, is429);
  return failure ?? productResponse(requestUrl);
}
globalThis.fetch = async (input: RequestInfo | URL) => {
  upstreamCalls += 1;
  const requestUrl = input instanceof Request ? input.url : String(input);
  return mockedUpstream(requestUrl, upstreamMode);
};
export { WeatherBudgetCoordinator };
export default {
  async fetch(request: Request, env: Parameters<typeof coordinator.fetch>[1]): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/_test/upstream-count') return Response.json({ count: upstreamCalls });
    if (url.pathname === '/_test/provider') { upstreamMode = url.searchParams.get('mode') as typeof upstreamMode; return new Response(null, { status: 204 }); }
    if (url.pathname === '/_test/release') { releaseFetch?.(); blockedFetch = undefined; return new Response(null, { status: 204 }); }
    if (url.pathname === '/_test/advance') { clock += Number(url.searchParams.get('ms') ?? 0); return Response.json({ now: clock }); }
    if (url.pathname === '/_test/clock-sequence') { clockSequence = url.searchParams.has('first') ? [Number(url.searchParams.get('first')), ...(url.searchParams.has('second') ? [Number(url.searchParams.get('second'))] : []), ...(url.searchParams.has('third') ? [Number(url.searchParams.get('third'))] : [])] : []; return new Response(null, { status: 204 }); }
    return coordinator.fetch(request, env);
  },
};
