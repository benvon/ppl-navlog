import type { BudgetAttempt, WeatherResourceEnvelope, WeatherResourceKey } from '../weather-resources/contracts';
import { budgetDecision } from '../weather-resources/policy';
import { parseResourceKey, isWeatherResourceEnvelope } from '../weather-resources/validation';

export interface SqlCursor<T> { toArray(): T[]; }
export interface SqlStorage { exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlCursor<T>; }
export interface StoreStorage { sql: SqlStorage; transactionSync<T>(closure: () => T): T; }
type Row = Record<string, unknown>;
type ExistingState = { generation: number; leaseUntilMs: number; failures: number; retryAtMs: number } | undefined;
export type Reservation = { allowed: true; generation: number } | { allowed: false; retryAtMs: number };
const COOLDOWNS = [60_000, 120_000, 300_000] as const;
const ATTEMPT_RETENTION_MS = 86_400_000;
const LEASE_MS = 30_000;

/** Persistent authoritative accounting. All SQL values are bound parameters. */
export class WeatherBudgetStore {
  private initialized = false;
  constructor(private readonly storage: StoreStorage) {}
  private get sql(): SqlStorage { return this.storage.sql; }
  private validKey(key: WeatherResourceKey): void { if (parseResourceKey(key) !== key) throw new Error('Invalid resource key.'); }
  private init(): void {
    if (this.initialized) return;
    this.sql.exec('CREATE TABLE IF NOT EXISTS attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, resource_key TEXT NOT NULL, attempted_at INTEGER NOT NULL)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS attempts_time ON attempts(attempted_at)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS resources (resource_key TEXT PRIMARY KEY, generation INTEGER NOT NULL, envelope TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS resource_state (resource_key TEXT PRIMARY KEY, generation INTEGER NOT NULL, lease_until INTEGER NOT NULL, failures INTEGER NOT NULL, retry_at INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS provider_state (id INTEGER PRIMARY KEY CHECK(id=1), retry_at INTEGER, operator_required INTEGER NOT NULL DEFAULT 0, last_clock INTEGER NOT NULL)');
    this.sql.exec('INSERT OR IGNORE INTO provider_state(id,retry_at,operator_required,last_clock) VALUES(1,0,0,0)');
    this.initialized = true;
  }
  private clamp(now: number): number {
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isFinite(new Date(now).getTime())) throw new Error('Invalid accounting clock.');
    const row = this.sql.exec<Row>('SELECT last_clock FROM provider_state WHERE id=1').toArray()[0];
    const clamped = Math.max(now, Number(row?.last_clock ?? 0));
    this.sql.exec('UPDATE provider_state SET last_clock=? WHERE id=1', clamped);
    return clamped;
  }
  private readState(key: WeatherResourceKey): ExistingState {
    const row = this.sql.exec<Row>('SELECT generation,lease_until,failures,retry_at FROM resource_state WHERE resource_key=?', key).toArray()[0];
    return row ? { generation: Number(row.generation), leaseUntilMs: Number(row.lease_until), failures: Number(row.failures), retryAtMs: Number(row.retry_at) } : undefined;
  }
  private recoverLease(key: WeatherResourceKey, state: ExistingState, now: number): { failures: number; retryAtMs: number; denied?: Reservation } {
    if (!state) return { failures: 0, retryAtMs: 0 };
    if (state.leaseUntilMs > now) return { failures: state.failures, retryAtMs: state.retryAtMs, denied: { allowed: false, retryAtMs: state.leaseUntilMs } };
    if (state.leaseUntilMs === 0) return { failures: state.failures, retryAtMs: state.retryAtMs };
    const failures = Math.min(3, state.failures + 1);
    const retryAtMs = now + COOLDOWNS[failures - 1]!;
    this.sql.exec('UPDATE resource_state SET lease_until=0,failures=?,retry_at=? WHERE resource_key=?', failures, retryAtMs, key);
    return { failures, retryAtMs };
  }
  private budgetRetryAt(key: WeatherResourceKey, now: number): number {
    const provider = this.sql.exec<Row>('SELECT retry_at,operator_required FROM provider_state WHERE id=1').toArray()[0];
    const providerRetry = Number(provider?.operator_required) === 1 ? Number.MAX_SAFE_INTEGER : Number(provider?.retry_at ?? 0);
    const attempts = this.sql.exec<Row>('SELECT resource_key,attempted_at FROM attempts WHERE attempted_at>? AND attempted_at<=? ORDER BY attempted_at', now - ATTEMPT_RETENTION_MS, now).toArray().map((row): BudgetAttempt => ({ key: String(row.resource_key) as WeatherResourceKey, attemptedAtMs: Number(row.attempted_at) }));
    const decision = budgetDecision(key, attempts, now);
    return Math.max(providerRetry, decision.allowed ? now : decision.retryAtMs);
  }
  private reserveInTransaction(key: WeatherResourceKey, nowMs: number): Reservation {
    const now = this.clamp(nowMs);
    const state = this.readState(key);
    const recovered = this.recoverLease(key, state, now);
    if (recovered.denied) return recovered.denied;
    const retryAtMs = Math.max(recovered.retryAtMs, this.budgetRetryAt(key, now));
    if (retryAtMs > now) return { allowed: false, retryAtMs };
    const generation = (state?.generation ?? 0) + 1;
    this.sql.exec('INSERT INTO attempts(resource_key,attempted_at) VALUES(?,?)', key, now);
    this.sql.exec('INSERT INTO resource_state(resource_key,generation,lease_until,failures,retry_at) VALUES(?,?,?,?,0) ON CONFLICT(resource_key) DO UPDATE SET generation=excluded.generation,lease_until=excluded.lease_until,failures=excluded.failures,retry_at=0', key, generation, now + LEASE_MS, recovered.failures);
    this.sql.exec('DELETE FROM attempts WHERE attempted_at<=?', now - ATTEMPT_RETENTION_MS);
    this.sql.exec('DELETE FROM resources WHERE resource_key NOT IN (SELECT resource_key FROM resources ORDER BY rowid DESC LIMIT 10)');
    return { allowed: true, generation };
  }
  async reserveAttempt(key: WeatherResourceKey, nowMs: number): Promise<Reservation> {
    this.validKey(key); this.init();
    return this.storage.transactionSync(() => this.reserveInTransaction(key, nowMs));
  }
  private parseStoredResource(serialized: unknown, key: WeatherResourceKey): WeatherResourceEnvelope | undefined {
    try { const parsed: unknown = JSON.parse(String(serialized)); return isWeatherResourceEnvelope(parsed) && parsed.key === key ? parsed : undefined; } catch { return undefined; }
  }
  async readResource(key: WeatherResourceKey): Promise<WeatherResourceEnvelope | undefined> {
    this.validKey(key); this.init();
    return this.storage.transactionSync(() => {
      const row = this.sql.exec<Row>('SELECT envelope FROM resources WHERE resource_key=?', key).toArray()[0];
      return row ? this.parseStoredResource(row.envelope, key) : undefined;
    });
  }
  private regresses(previous: WeatherResourceEnvelope | undefined, current: WeatherResourceEnvelope): boolean {
    if (previous?.kind !== 'winds' || current.kind !== 'winds') return false;
    const previousIssue = Math.max(...previous.forecasts.map((item) => Date.parse(item.issuedAt)));
    const currentIssue = Math.max(...current.forecasts.map((item) => Date.parse(item.issuedAt)));
    return currentIssue < previousIssue;
  }
  private publishInTransaction(key: WeatherResourceKey, generation: number, resource: WeatherResourceEnvelope, nowMs: number): boolean {
    if (resource.key !== key || !isWeatherResourceEnvelope(resource)) return false;
    const now = this.clamp(nowMs);
    if (Date.parse(resource.metadata.checkedAt) > now) return false;
    const state = this.sql.exec<Row>('SELECT generation,lease_until FROM resource_state WHERE resource_key=?', key).toArray()[0];
    if (Number(state?.generation) !== generation || Number(state?.lease_until) <= now) return false;
    const previousRow = this.sql.exec<Row>('SELECT envelope FROM resources WHERE resource_key=?', key).toArray()[0];
    const previous = previousRow ? this.parseStoredResource(previousRow.envelope, key) : undefined;
    if (this.regresses(previous, resource)) return false;
    this.sql.exec('INSERT INTO resources(resource_key,generation,envelope) VALUES(?,?,?) ON CONFLICT(resource_key) DO UPDATE SET generation=excluded.generation,envelope=excluded.envelope', key, generation, JSON.stringify(resource));
    this.sql.exec('UPDATE resource_state SET lease_until=0,failures=0,retry_at=0 WHERE resource_key=? AND generation=?', key, generation);
    return true;
  }
  async publishResource(key: WeatherResourceKey, generation: number, resource: WeatherResourceEnvelope, nowMs: number): Promise<boolean> {
    this.validKey(key); this.init();
    return this.storage.transactionSync(() => this.publishInTransaction(key, generation, resource, nowMs));
  }
  async recordFailure(key: WeatherResourceKey, generation: number, nowMs: number, providerRetryAtMs?: number | 'operator_required'): Promise<void> {
    this.validKey(key); this.init();
    this.storage.transactionSync(() => {
      const now = this.clamp(nowMs);
      const row = this.sql.exec<Row>('SELECT failures,generation FROM resource_state WHERE resource_key=?', key).toArray()[0];
      if (Number(row?.generation) !== generation) return;
      const failures = Math.min(3, Number(row?.failures ?? 0) + 1);
      this.sql.exec('UPDATE resource_state SET failures=?,lease_until=0,retry_at=? WHERE resource_key=? AND generation=?', failures, now + COOLDOWNS[failures - 1]!, key, generation);
      if (providerRetryAtMs === undefined) return;
      if (providerRetryAtMs === 'operator_required' || !Number.isSafeInteger(providerRetryAtMs) || providerRetryAtMs < now) this.sql.exec('UPDATE provider_state SET retry_at=NULL,operator_required=1 WHERE id=1');
      else this.sql.exec('UPDATE provider_state SET retry_at=MAX(COALESCE(retry_at,0),?),operator_required=0 WHERE id=1 AND operator_required=0', providerRetryAtMs);
    });
  }
  async readResourceState(key: WeatherResourceKey): Promise<{ generation: number; leaseUntilMs: number; failures: number; retryAtMs: number } | undefined> {
    this.validKey(key); this.init();
    return this.storage.transactionSync(() => this.readState(key));
  }
  async readProviderCooldown(): Promise<number | null | 'operator_required'> {
    this.init();
    const row = this.sql.exec<Row>('SELECT retry_at,operator_required FROM provider_state WHERE id=1').toArray()[0];
    return Number(row?.operator_required) === 1 ? 'operator_required' : Number(row?.retry_at ?? 0) || null;
  }
  async readAccountingMetadata(): Promise<{ attempts24h: number; resources: number; providerCooldownUntil: number | null | 'operator_required' }> {
    this.init();
    const attempts = this.sql.exec<Row>('SELECT COUNT(*) AS count FROM attempts').toArray()[0];
    const resources = this.sql.exec<Row>('SELECT COUNT(*) AS count FROM resources').toArray()[0];
    const provider = this.sql.exec<Row>('SELECT retry_at,operator_required FROM provider_state WHERE id=1').toArray()[0];
    return { attempts24h: Number(attempts?.count ?? 0), resources: Number(resources?.count ?? 0), providerCooldownUntil: Number(provider?.operator_required) === 1 ? 'operator_required' : Number(provider?.retry_at ?? 0) || null };
  }
  async clearResource(key: WeatherResourceKey): Promise<void> {
    this.validKey(key); this.init();
    this.storage.transactionSync(() => { this.sql.exec('DELETE FROM resources WHERE resource_key=?', key); });
  }
}
