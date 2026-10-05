import coordinator, { WeatherBudgetCoordinator } from './index';

type UpstreamMode = 'ok' | 'blocked' | 'blocked-fail' | '429' | 'fail' | 'race';
let upstreamCalls = 0;
let completedUpstreamCalls = 0;
let resourceRequests = 0;
let upstreamMode: UpstreamMode = 'ok';
const realDateNow = Date.now.bind(Date);
let clock: number | undefined;
let clockSequence: number[] = [];
let releaseFetch!: () => void;
let blockedFetch: Promise<void> | undefined;
Date.now = () => clockSequence.shift() ?? clock ?? realDateNow();
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], timeout?: number, ...args: unknown[]) => nativeSetTimeout(handler, timeout === 5_000 ? 30_000 : timeout, ...args)) as typeof setTimeout;

function ensureClock(): number { return clock ??= realDateNow(); }
function isCatalogRequest(requestUrl: string): boolean { return new URL(requestUrl).pathname === '/data/cache/stations.cache.json.gz'; }
async function catalogResponse(): Promise<Response> {
  const bytes = new TextEncoder().encode(JSON.stringify([
    { iataId: 'ABC', site: 'Test Station', lat: 40, lon: -100, elev: 0 },
    { iataId: 'ANC', site: 'Alaska Test Station', lat: 61.2, lon: -149.9, elev: 0 },
    { iataId: 'HNL', site: 'Hawaii Test Station', lat: 21.3, lon: -157.8, elev: 0 }
  ]));
  return new Response(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}
function isBlocked(mode: UpstreamMode, is429: boolean): boolean { return mode === 'blocked' || mode === 'blocked-fail' || (mode === 'race' && !is429); }
async function waitForRelease(): Promise<void> {
  blockedFetch ??= new Promise<void>((resolve) => { releaseFetch = resolve; });
  await blockedFetch;
}
function upstreamFailure(mode: UpstreamMode, is429: boolean): Response | undefined {
  if (is429) return new Response('', { status: 429, headers: { 'Retry-After': '60' } });
  if (mode === 'fail' || mode === 'blocked-fail') return new Response('', { status: 500 });
  return undefined;
}
function productResponse(requestUrl: string): Response {
  const url = new URL(requestUrl);
  const cycle = url.searchParams.get('fcst');
  const region = url.searchParams.get('region');
  const station = region === 'alaska' ? 'ANC' : region === 'hawaii' ? 'HNL' : 'ABC';
  const currentDate = new Date(ensureClock());
  const day = String(currentDate.getUTCDate()).padStart(2, '0');
  const nextDay = String(new Date(Date.UTC(currentDate.getUTCFullYear(), currentDate.getUTCMonth(), currentDate.getUTCDate() + 1)).getUTCDate()).padStart(2, '0');
  const product = cycle === '12' ? `DATA BASED ON ${day}0000Z\nVALID ${day}1200Z FOR USE 1200-1800Z\nFT 3000\nABC2700`
    : cycle === '24' ? `DATA BASED ON ${day}0000Z\nVALID ${nextDay}0000Z FOR USE 1800-0000Z\nFT 3000\nABC2700`
      : `DATA BASED ON ${day}0000Z\nVALID ${day}0600Z FOR USE 0600-1200Z\nFT 3000\nABC2700`;
  return new Response(product.replace('ABC2700', `${station}2700`), { status: 200 });
}
async function mockedUpstream(requestUrl: string): Promise<Response> {
  const is429 = upstreamMode === '429' || (upstreamMode === 'race' && new URL(requestUrl).searchParams.get('fcst') === '24');
  if (isBlocked(upstreamMode, is429)) await waitForRelease();
  const failure = upstreamFailure(upstreamMode, is429);
  if (failure) return failure;
  return isCatalogRequest(requestUrl) ? catalogResponse() : productResponse(requestUrl);
}
globalThis.fetch = async (input: RequestInfo | URL) => {
  upstreamCalls += 1;
  const requestUrl = input instanceof Request ? input.url : String(input);
  const response = await mockedUpstream(requestUrl);
  completedUpstreamCalls += 1;
  return response;
};

function testControl(url: URL): Response {
  const controls: Record<string, () => Response> = {
    '/_test/upstream-count': () => Response.json({ count: upstreamCalls }),
    '/_test/upstream-completed-count': () => Response.json({ count: completedUpstreamCalls }),
    '/_test/resource-count': () => Response.json({ count: resourceRequests }),
    '/_test/provider': () => {
      const mode = url.searchParams.get('mode');
      if (!['ok', 'blocked', 'blocked-fail', '429', 'fail', 'race'].includes(mode ?? '')) return new Response(null, { status: 400 });
      upstreamMode = mode as UpstreamMode;
      return new Response(null, { status: 204 });
    },
    '/_test/release': () => { releaseFetch?.(); blockedFetch = undefined; return new Response(null, { status: 204 }); },
    '/_test/advance': () => { clock = ensureClock() + Number(url.searchParams.get('ms') ?? 0); return Response.json({ now: clock }); },
    '/_test/clock-sequence': () => {
      clockSequence = url.searchParams.has('first') ? [Number(url.searchParams.get('first')), ...(url.searchParams.has('second') ? [Number(url.searchParams.get('second'))] : []), ...(url.searchParams.has('third') ? [Number(url.searchParams.get('third'))] : [])] : [];
      return new Response(null, { status: 204 });
    }
  };
  return controls[url.pathname]?.() ?? new Response(null, { status: 404 });
}

/** Runtime-only Durable Object controls stay out of the deployed coordinator artifact. */
export class WeatherBudgetTestCoordinator extends WeatherBudgetCoordinator {
  override async fetch(request: Request): Promise<Response> {
    ensureClock();
    const url = new URL(request.url);
    if (url.pathname.startsWith('/_test/')) return testControl(url);
    if (url.pathname === '/resource') resourceRequests += 1;
    return super.fetch(request);
  }
}

interface RuntimeEnv {
  WEATHER_BUDGET: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
}
export { WeatherBudgetCoordinator };
export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/_test/')) {
      return env.WEATHER_BUDGET.get(env.WEATHER_BUDGET.idFromName('awc-budget-v1')).fetch(request);
    }
    return coordinator.fetch(request, env);
  },
};
