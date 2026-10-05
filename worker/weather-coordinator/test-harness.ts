import { WeatherBudgetStore, type StoreStorage } from './store';
import type { WeatherResourceKey, WeatherResourceEnvelope } from '../weather-resources/contracts';

/** Test-only Worker and Durable Object; not referenced by production bindings. */
export class WeatherBudgetTestHarness {
  private readonly store: WeatherBudgetStore;
  private readonly sql: StoreStorage['sql'];
  constructor(ctx: { storage: StoreStorage }) { this.sql = ctx.storage.sql; this.store = new WeatherBudgetStore(ctx.storage); }
  async fetch(request: Request): Promise<Response> {
    const body = await request.json() as Record<string, unknown>;
    const key = body.key as WeatherResourceKey;
    if (body.op === 'reserve') return Response.json(await this.store.reserveAttempt(key, Number(body.now)));
    if (body.op === 'cooldown') return Response.json({ cooldown: await this.store.readProviderCooldown() });
    if (body.op === 'state') return Response.json(await this.store.readResourceState(key) ?? null);
    if (body.op === 'metadata') return Response.json(await this.store.readAccountingMetadata());
    if (body.op === 'fault') { await this.store.readAccountingMetadata(); this.sql.exec("CREATE TRIGGER fail_debit BEFORE INSERT ON attempts BEGIN SELECT RAISE(ABORT, 'storage fault'); END"); return Response.json({ ok: true }); }
    if (body.op === 'corrupt') { this.sql.exec('INSERT OR REPLACE INTO resources(resource_key,generation,envelope) VALUES(?,?,?)', key, 1, '{'); return Response.json({ ok: true }); }
    if (body.op === 'read') return Response.json({ resource: await this.store.readResource(key) ?? null });
    if (body.op === 'publish') return Response.json({ published: await this.store.publishResource(key, Number(body.generation), body.resource as WeatherResourceEnvelope, Number(body.now)) });
    if (body.op === 'fail') { await this.store.recordFailure(key, Number(body.generation), Number(body.now), body.providerRetryAt as number | 'operator_required' | undefined); return Response.json({ ok: true }); }
    return new Response('bad op', { status: 400 });
  }
}
export default { fetch: async (request: Request, env: { STORE: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } } }) => {
  const body = await request.clone().json() as { objectId?: number };
  const id = env.STORE.idFromName(String(body.objectId ?? 1));
  return env.STORE.get(id).fetch(request);
} };
