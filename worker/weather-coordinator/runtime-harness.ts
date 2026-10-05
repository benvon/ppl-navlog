import coordinator, { WeatherBudgetCoordinator } from './index';

/** Test-only upstream response; production bindings and routes do not include this hook. */
let upstreamCalls = 0;
let upstreamMode: 'ok' | 'blocked' | 'blocked-fail' | '429' | 'fail' | 'race' = 'ok';
let clock = Date.now();
let releaseFetch!: () => void;
let blockedFetch: Promise<void> | undefined;
Date.now = () => clock;
globalThis.fetch = async (input: RequestInfo | URL) => {
  upstreamCalls += 1;
  const mode = upstreamMode;
  const requestUrl = input instanceof Request ? input.url : String(input);
  const is429 = mode === '429' || (mode === 'race' && new URL(requestUrl).searchParams.get('fcst') === '24');
  if (mode === 'blocked' || mode === 'blocked-fail' || (mode === 'race' && !is429)) {
    blockedFetch ??= new Promise<void>((resolve) => { releaseFetch = resolve; });
    await blockedFetch;
  }
  if (is429) return new Response('', { status: 429, headers: { 'Retry-After': '60' } });
  if (mode === 'fail' || mode === 'blocked-fail') return new Response('', { status: 500 });
  return new Response('DATA BASED ON 050000Z\nVALID 050600Z FOR USE 0600-1200Z\nFT 3000\nABC2700', { status: 200 });
};
export { WeatherBudgetCoordinator };
export default {
  async fetch(request: Request, env: Parameters<typeof coordinator.fetch>[1]): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/_test/upstream-count') return Response.json({ count: upstreamCalls });
    if (url.pathname === '/_test/provider') { upstreamMode = url.searchParams.get('mode') as typeof upstreamMode; return new Response(null, { status: 204 }); }
    if (url.pathname === '/_test/release') { releaseFetch?.(); blockedFetch = undefined; return new Response(null, { status: 204 }); }
    if (url.pathname === '/_test/advance') { clock += Number(url.searchParams.get('ms') ?? 0); return Response.json({ now: clock }); }
    return coordinator.fetch(request, env);
  },
};
