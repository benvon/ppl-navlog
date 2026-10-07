/** Small adapter-instance cache for exact-key requests. Values are copied at every ownership boundary. */
export const MAX_REUSE_ENTRIES = 128;
export const MAX_REUSE_BYTES = 1024 * 1024;
export const MAX_ACTIVE_REUSE_KEYS = 128;
export const MAX_RETRY_AFTER_MS = 86_400_000;

export function retryAfterDeadline(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds)) return undefined;
    return now + Math.min(MAX_RETRY_AFTER_MS, Math.max(0, seconds * 1000));
  }
  const timestamp = parseHttpDate(trimmed);
  if (timestamp === undefined) return undefined;
  return now + Math.min(MAX_RETRY_AFTER_MS, Math.max(0, timestamp - now));
}

function parseHttpDate(value: string): number | undefined {
  const supportedDate = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), ([0-9]{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{4}) ([0-9]{2}:[0-9]{2}:[0-9]{2}) GMT$/.exec(value);
  if (supportedDate === null) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toUTCString() === value ? timestamp : undefined;
}

export class RequestReuse<T> {
  private readonly active = new Map<string, Promise<T>>();
  private readonly entries = new Map<string, { value: T; bytes: number; deadline: number }>();
  private readonly cooldowns = new Map<string, { deadline: number; error: unknown }>();
  private retainedBytes = 0;

  public constructor(private readonly copy: (value: T) => T = (value) => structuredClone(value)) {}

  public async run(key: string, options: {
    now?: () => number;
    freshness?: (value: T) => number | undefined;
    age?: (value: T, now: number) => T;
    safeError?: (error: unknown) => unknown;
    validateReuse?: (value: T) => void;
    retryAfter?: () => string | null;
    request: () => Promise<T>;
  }): Promise<T> {
    const now = options.now ?? Date.now;
    const time = now();
    this.prune(time);
    const cached = this.cached(key, time, now, options);
    if (cached !== undefined) return cached;
    this.checkCooldown(key, time, options);
    const active = this.active.get(key);
    if (active !== undefined) return this.copy(await active);
    if (this.active.size >= MAX_ACTIVE_REUSE_KEYS) return this.track(key, now, options, false);
    return this.track(key, now, options);
  }

  private cached(key: string, time: number, now: () => number, options: Parameters<RequestReuse<T>["run"]>[1]): T | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.deadline <= time) { this.deleteEntry(key); return undefined; }
    options.validateReuse?.(this.copy(entry.value));
    this.entries.delete(key);
    this.entries.set(key, entry);
    const value = this.copy(options.age?.(this.copy(entry.value), now()) ?? entry.value);
    options.validateReuse?.(this.copy(value));
    return this.copy(value);
  }

  private checkCooldown(key: string, now: number, options: Parameters<RequestReuse<T>["run"]>[1]): void {
    const cooldown = this.cooldowns.get(key);
    if (cooldown === undefined) return;
    if (cooldown.deadline > now) throw options.safeError?.(cooldown.error) ?? safeError(cooldown.error);
    this.cooldowns.delete(key);
  }

  private async track(key: string, now: () => number, options: Parameters<RequestReuse<T>["run"]>[1], trackActive = true): Promise<T> {
    const pending = options.request();
    if (trackActive) this.active.set(key, pending);
    try {
      return await this.trackSuccess(key, pending, now, options);
    } catch (error) {
      this.recordFailure(key, now, options, error);
      throw error;
    } finally {
      if (trackActive) this.active.delete(key);
    }
  }

  private async trackSuccess(key: string, pending: Promise<T>, now: () => number, options: Parameters<RequestReuse<T>["run"]>[1]): Promise<T> {
    const value = await pending;
    const deadline = options.freshness?.(value);
    const completedAt = now();
    if (deadline !== undefined && deadline > completedAt) {
      this.prune(completedAt);
      this.retain(key, value, deadline);
    }
    return this.copy(value);
  }

  private recordFailure(key: string, now: () => number, options: Parameters<RequestReuse<T>["run"]>[1], error: unknown): void {
    const until = retryAfterDeadline(options.retryAfter?.() ?? null, now());
    if (until !== undefined && until > now()) this.setCooldown(key, until, options.safeError?.(error) ?? safeError(error));
  }

  private retain(key: string, value: T, deadline: number): void {
    const owned = this.copy(value);
    const bytes = new TextEncoder().encode(JSON.stringify(owned)).byteLength;
    if (bytes > MAX_REUSE_BYTES) return;
    this.deleteEntry(key);
    while (this.entries.size >= MAX_REUSE_ENTRIES || this.retainedBytes + bytes > MAX_REUSE_BYTES) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.deleteEntry(oldest);
    }
    this.entries.set(key, { value: owned, bytes, deadline });
    this.retainedBytes += bytes;
  }

  private setCooldown(key: string, deadline: number, error: unknown): void {
    if (this.cooldowns.has(key)) this.cooldowns.delete(key);
    while (this.cooldowns.size >= MAX_REUSE_ENTRIES) {
      const oldest = this.cooldowns.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cooldowns.delete(oldest);
    }
    this.cooldowns.set(key, { deadline, error });
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) if (entry.deadline <= now) this.deleteEntry(key);
    for (const [key, value] of this.cooldowns) if (value.deadline <= now) this.cooldowns.delete(key);
  }

  private deleteEntry(key: string): void {
    const entry = this.entries.get(key);
    if (entry !== undefined) this.retainedBytes -= entry.bytes;
    this.entries.delete(key);
  }
}

function safeError(error: unknown): Error {
  if (!(error instanceof Error)) return new Error("Request temporarily unavailable.");
  const safe = new Error(error.message.slice(0, 512));
  safe.name = error.name;
  return safe;
}
