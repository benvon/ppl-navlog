import { describe, expect, it, vi } from "vitest";
import { MAX_REUSE_BYTES, RequestReuse, retryAfterDeadline } from "./request-reuse";

describe("request reuse", () => {
  it("joins identical active requests and gives each caller an isolated copy", async () => {
    const reuse = new RequestReuse<{ value: number }>();
    let release!: (value: { value: number }) => void;
    const request = vi.fn(() => new Promise<{ value: number }>((resolve) => { release = resolve; }));
    const first = reuse.run("exact", { request });
    const second = reuse.run("exact", { request });
    release({ value: 1 });
    const [a, b] = await Promise.all([first, second]);
    a.value = 2;
    expect(b.value).toBe(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("expires at the deadline and computes elapsed freshness without changing provenance", async () => {
    let time = 0;
    const reuse = new RequestReuse<{ freshness: number; servedAt: string; ageSeconds: number }>();
    const initial = { freshness: 5, servedAt: "fixed", ageSeconds: 7 };
    const request = vi.fn(async () => initial);
    const opts = { now: () => time, freshness: () => 5000, age: (value: typeof initial, now: number) => ({ ...value, freshness: Math.max(0, value.freshness - Math.floor((now - 0) / 1000)) }), request };
    await reuse.run("a", opts);
    time = 3000;
    expect(await reuse.run("a", opts)).toEqual({ freshness: 2, servedAt: "fixed", ageSeconds: 7 });
    time = 5000;
    await reuse.run("a", opts);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("applies exact-key Retry-After cooldowns, expires them lazily, and clears failed active work", async () => {
    let time = 1000;
    let retry: string | null = "2";
    const reuse = new RequestReuse<{ value: number }>();
    const request = vi.fn(async () => { throw new Error("temporarily unavailable"); });
    const options = { now: () => time, retryAfter: () => retry, request };
    await expect(reuse.run("a", options)).rejects.toThrow("temporarily unavailable");
    await expect(reuse.run("a", options)).rejects.toThrow("temporarily unavailable");
    await expect(reuse.run("b", options)).rejects.toThrow("temporarily unavailable");
    expect(request).toHaveBeenCalledTimes(2);
    time = 3000;
    retry = null;
    await expect(reuse.run("a", options)).rejects.toThrow("temporarily unavailable");
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("returns a fresh bounded cooldown error so one caller cannot mutate later failures", async () => {
    const time = 0;
    const reuse = new RequestReuse<{ value: number }>();
    const options = { now: () => time, retryAfter: () => "10", request: async () => { throw new Error("safe error"); } };
    await expect(reuse.run("cooldown", options)).rejects.toThrow("safe error");
    try { await reuse.run("cooldown", options); } catch (error) { (error as Error).message = "caller mutation"; }
    await expect(reuse.run("cooldown", options)).rejects.toThrow("safe error");
  });

  it("prunes entries expired during an in-flight request before LRU eviction", async () => {
    let time = 0;
    const reuse = new RequestReuse<{ deadline: number }>();
    let keptCalls = 0;
    for (let index = 0; index < 128; index++) {
      const key = index === 0 ? "fresh-oldest" : `expires-${index}`;
      const deadline = index === 0 ? 10_000 : 100;
      await reuse.run(key, { now: () => time, freshness: (value) => value.deadline, request: async () => ({ deadline }) });
    }
    await reuse.run("new", { now: () => time, freshness: (value) => value.deadline, request: async () => { time = 101; return { deadline: 10_000 }; } });
    await reuse.run("fresh-oldest", { now: () => time, freshness: (value) => value.deadline, request: async () => { keptCalls++; return { deadline: 10_000 }; } });
    expect(keptCalls).toBe(0);
  });

  it("caps retained entry count, evicts least recently used, and skips oversized values", async () => {
    const reuse = new RequestReuse<{ text: string }>();
    const now = () => 0;
    const request = vi.fn(async () => ({ text: "x".repeat(1024) }));
    const run = (key: string) => reuse.run(key, { now, freshness: () => 10000, request });
    for (let i = 0; i < 128; i++) await run(String(i));
    await run("0");
    await run("128");
    await run("0");
    await run("1");
    expect(request).toHaveBeenCalledTimes(130);
    const oversized = new RequestReuse<{ text: string }>();
    const tooLarge = vi.fn(async () => ({ text: "x".repeat(1024 * 1024 + 1) }));
    await oversized.run("large", { now, freshness: () => 10000, request: tooLarge });
    await oversized.run("large", { now, freshness: () => 10000, request: tooLarge });
    expect(tooLarge).toHaveBeenCalledTimes(2);
  });

  it("enforces aggregate UTF-8 byte limit, exact boundary, and byte-based LRU eviction", async () => {
    const reuse = new RequestReuse<{ text: string }>();
    const now = () => 0;
    const exact = { text: "é".repeat(100) + "x".repeat(MAX_REUSE_BYTES - 11 - 200) };
    expect(new TextEncoder().encode(JSON.stringify(exact)).byteLength).toBe(MAX_REUSE_BYTES);
    const request = vi.fn(async (value: { text: string }) => value);
    const run = (key: string, value: { text: string }) => reuse.run(key, { now, freshness: () => 1000, request: () => request(value) });
    await run("boundary", exact);
    await run("small", { text: "second" });
    await run("boundary", exact);
    expect(request).toHaveBeenCalledTimes(3);
    const aggregate = new RequestReuse<{ text: string }>();
    const half = { text: "y".repeat(600_000) };
    const aggregateFetch = vi.fn(async () => half);
    const get = (key: string) => aggregate.run(key, { now, freshness: () => 1000, request: aggregateFetch });
    await get("first"); await get("second"); await get("first");
    expect(aggregateFetch).toHaveBeenCalledTimes(3);
  });

  it("keeps active tracking and cooldown retention bounded while overflow still honors Retry-After", async () => {
    let time = 0;
    const reuse = new RequestReuse<{ value: number }>();
    const releases: Array<(value: { value: number }) => void> = [];
    let overflowCalls = 0;
    const pending = (key: string) => reuse.run(key, { request: () => new Promise((resolve) => releases.push(resolve)) });
    const active = Array.from({ length: 128 }, (_, index) => pending(`active-${index}`));
    const overflowReleases: Array<(value: { value: number }) => void> = [];
    const bypassOptions = { request: () => new Promise<{ value: number }>((resolve) => overflowReleases.push(resolve)) };
    const bypassA = reuse.run("overflow-pending", bypassOptions);
    const bypassB = reuse.run("overflow-pending", bypassOptions);
    expect(overflowReleases).toHaveLength(2);
    const overflowOptions = { now: () => time, retryAfter: () => "5", request: async () => { overflowCalls++; throw new Error("busy"); } };
    await expect(reuse.run("overflow", overflowOptions)).rejects.toThrow("busy");
    await expect(reuse.run("overflow", overflowOptions)).rejects.toThrow("busy");
    expect(overflowCalls).toBe(1);
    time = 5000;
    await expect(reuse.run("overflow", { ...overflowOptions, request: async () => ({ value: 1 }) })).resolves.toEqual({ value: 1 });
    for (const release of overflowReleases) release({ value: 2 });
    await Promise.all([bypassA, bypassB]);
    for (const release of releases) release({ value: 1 });
    await Promise.all(active);

    const cooldowns = new RequestReuse<{ value: number }>();
    let calls = 0;
    const fail = (key: string) => cooldowns.run(key, { retryAfter: () => "60", request: async () => { calls++; throw new Error("busy"); } });
    for (let index = 0; index < 129; index++) await expect(fail(`cool-${index}`)).rejects.toThrow("busy");
    await expect(fail("cool-0")).rejects.toThrow("busy");
    expect(calls).toBe(130);
  });

  it("parses Retry-After delta seconds and HTTP dates with an 86400 second cap", () => {
    expect(retryAfterDeadline("3", 1000)).toBe(4000);
    expect(retryAfterDeadline("invalid", 1000)).toBeUndefined();
    expect(retryAfterDeadline("2099-01-01", 1000)).toBeUndefined();
    expect(retryAfterDeadline("1.5", 1000)).toBeUndefined();
    expect(retryAfterDeadline("-1", 1000)).toBeUndefined();
    expect(retryAfterDeadline("Tue, 01 Jan 2020 00:00:00 GMT", 1000)).toBeUndefined();
    expect(retryAfterDeadline("Thu, 01 Jan 1970 00:00:00 GMT", 1000)).toBe(1000);
    expect(retryAfterDeadline("Thu, 01 Jan 1970 00:00:04 GMT", 1000)).toBe(4000);
    expect(retryAfterDeadline("Sunday, 06-Nov-94 08:49:37 GMT", 1000)).toBeUndefined();
    expect(retryAfterDeadline("Sun Nov  6 08:49:37 1994", 1000)).toBeUndefined();
    expect(retryAfterDeadline("86401", 1000)).toBe(86_401_000);
  });
});
