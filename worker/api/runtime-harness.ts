import worker, { type Env } from '../index';

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return worker.fetch(request, {
      ...env,
      API_RATE_LIMITER: { limit: async () => ({ success: true }) },
      ASSETS: { fetch: async () => new Response(null, { status: 404 }) }
    });
  }
};
