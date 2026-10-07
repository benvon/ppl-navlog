import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AloftPointAnswer, AloftPointQuery } from "../../../worker/api/contracts";
import { completeFlightWeatherClient } from "../../test/fixtures/complete-flight";
import { WindsClientError, WorkerWindsClient } from "./winds-client";

const query: AloftPointQuery = { latitudeDeg: 42, longitudeDeg: -88, altitudeFeetMsl: 4500, plannedUtc: "2026-09-21T22:00:00.000Z" };
const id = "44444444-4444-4444-8444-444444444444";
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-21T21:30:00.000Z")); });
function point(): AloftPointAnswer {
  const cache = { status: "upstream_refresh" as const, source: "upstream" as const, ageSeconds: 0,
    fetchedAt: "2026-09-21T21:30:00.000Z", expiresAt: "2026-09-21T22:30:00.000Z", freshnessRemainingSeconds: 3600,
    servedAt: "2026-09-21T21:30:00.000Z", ttlSeconds: 3600, maxPayloadAgeSeconds: 3720,
    key: "winds:us:06", resource: "winds-temps", checkedAt: "2026-09-21T21:30:00.000Z",
    refreshAfter: "2026-09-21T22:30:00.000Z", staleUntil: "2026-09-21T22:32:00.000Z" };
  return {
    query, windFromDegTrue: 270, windSpeedKt: 12, temperatureC: 3,
    issuedAt: "2026-09-21T20:00:00.000Z", useFrom: "2026-09-21T21:00:00.000Z", useUntil: "2026-09-22T03:00:00.000Z",
    forecastCycle: "06", method: "station-level", requestId: id,
    product: { region: "us", cycle: "06", cache }, catalog: { cache: { ...cache, key: "station-catalog:v1", resource: "station-catalog", maxPayloadAgeSeconds: 86520, refreshAfter: "2026-09-22T21:30:00.000Z", expiresAt: "2026-09-22T21:30:00.000Z", staleUntil: "2026-09-22T21:32:00.000Z", ttlSeconds: 86400 } },
    sources: [{ stationId: "BRL", latitudeDeg: 42, longitudeDeg: -88, distanceNauticalMiles: 0, horizontalWeight: 1,
      lowerAltitudeFeet: 4500, upperAltitudeFeet: 4500, verticalWeight: 0, lowerWindFromDegTrue: 270, lowerWindSpeedKt: 12,
      upperWindFromDegTrue: 270, upperWindSpeedKt: 12, temperatureLowerAltitudeFeet: 4500, temperatureUpperAltitudeFeet: 4500,
      temperatureVerticalWeight: 0, temperatureLowerC: 3, temperatureUpperC: 3 }],
  };
}
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
function client(value: unknown, status = 200) {
  const fetch = vi.fn(async (_url: RequestInfo | URL) => json(value, status));
  return { api: new WorkerWindsClient({ fetch }, "https://worksheet.invalid"), fetch };
}
afterEach(() => vi.useRealTimers());

describe("current worksheet weather transport", () => {
  it("requests the exact point and accepts only matching valid evidence", async () => {
    const { api, fetch } = client(point());
    expect(await api.fetchPoint(query)).toEqual(point());
    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/api/weather/winds/point");
    expect(url.searchParams.get("lat")).toBe("42");
    expect(url.searchParams.get("altitudeFeetMsl")).toBe("4500");
  });
  it("reuses only the same fresh point and decreases freshness from servedAt", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => { const answer = point(); answer.query = { ...query, ...(new URL(String(input)).searchParams.get("altitudeFeetMsl") === "5000" ? { altitudeFeetMsl: 5000 } : {}) }; return json(answer); });
    const api = new WorkerWindsClient({ fetch }, "https://worksheet.invalid");
    const first = await api.fetchPoint(query);
    first.sources[0]!.stationId = "BAD";
    vi.advanceTimersByTime(3_000);
    const second = await api.fetchPoint(query);
    expect(second.sources[0]!.stationId).toBe("BRL");
    expect(second.product.cache.freshnessRemainingSeconds).toBe(3597);
    expect(second.product.cache.ageSeconds).toBe(0);
    expect(second.product.cache.servedAt).toBe("2026-09-21T21:30:00.000Z");
    expect(fetch).toHaveBeenCalledTimes(1);
    await api.fetchPoint({ ...query, altitudeFeetMsl: 5000 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retain provenance with an unrecognized source or resource key", async () => {
    vi.setSystemTime(new Date("2026-09-21T22:30:30.000Z"));
    const value = point();
    value.product.cache.status = "stale_on_error";
    value.product.cache.source = "stale";
    value.product.cache.freshnessRemainingSeconds = 0;
    value.product.cache.ageSeconds = 3630;
    value.product.cache.servedAt = "2026-09-21T22:30:30.000Z";
    const fetch = vi.fn(async () => json(value));
    const api = new WorkerWindsClient({ fetch }, "https://worksheet.invalid");
    await api.fetchPoint(query);
    await api.fetchPoint(query);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retains METAR only when payload, provenance, and resource timestamps agree and all deadlines remain fresh", async () => {
    const base = await completeFlightWeatherClient.fetchMetar("KORD");
    const valid = { ...base, provenance: { ...base.provenance, fetchedAt: base.metar.fetchedAt, cache: { ...base.provenance.cache,
      key: "v1:metar:KORD", fetchedAt: base.metar.fetchedAt, servedAt: base.metar.fetchedAt, ageSeconds: 0,
      expiresAt: "2026-09-21T21:50:00.000Z", freshnessRemainingSeconds: 1200, maxPayloadAgeSeconds: 7200 } } };
    const cases = [
      { name: "expiresAt", payload: valid, advanceMs: 20 * 60_000 },
      { name: "freshness", payload: { ...valid, provenance: { ...valid.provenance, cache: { ...valid.provenance.cache, freshnessRemainingSeconds: 1 } } }, advanceMs: 1000 },
      { name: "maxPayloadAge", payload: { ...valid, provenance: { ...valid.provenance, cache: { ...valid.provenance.cache, maxPayloadAgeSeconds: 1 } } }, advanceMs: 1000 },
      { name: "negative ttlSeconds", payload: { ...valid, provenance: { ...valid.provenance, cache: { ...valid.provenance.cache, ttlSeconds: -1 } } }, advanceMs: 0 },
      { name: "freshness beyond ttlSeconds", payload: { ...valid, provenance: { ...valid.provenance, cache: { ...valid.provenance.cache, ttlSeconds: 1199 } } }, advanceMs: 0 },
      { name: "mismatched cache fetchedAt", payload: { ...valid, provenance: { ...valid.provenance, cache: { ...valid.provenance.cache, fetchedAt: "2026-09-21T21:29:00.000Z", ageSeconds: 60 } } }, advanceMs: 0 },
    ];
    for (const testCase of cases) {
      vi.setSystemTime(new Date("2026-09-21T21:30:00.000Z"));
      const fetch = vi.fn(async () => json(testCase.payload));
      const api = new WorkerWindsClient({ fetch }, "https://worksheet.invalid");
      await api.fetchMetar("KORD");
      vi.advanceTimersByTime(testCase.advanceMs);
      await api.fetchMetar("KORD");
      expect(fetch, testCase.name).toHaveBeenCalledTimes(2);
    }
  });

  it("returns independent cooldown errors while preserving WindsClientError routing fields", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ code: "upstream_no_data", error: "hidden", requestId: id }), { status: 503, headers: { "Content-Type": "application/json", "Retry-After": "10" } }));
    const api = new WorkerWindsClient({ fetch }, "https://worksheet.invalid");
    let first: WindsClientError | undefined;
    try { await api.fetchPoint(query); } catch (error) { first = error as WindsClientError; }
    expect(first).toBeInstanceOf(WindsClientError);
    Object.assign(first!, { message: "caller mutation", code: "TRANSPORT_FAILURE", apiCode: "service_unavailable" });
    await expect(api.fetchPoint(query)).rejects.toMatchObject({ code: "API_FAILURE", apiCode: "upstream_no_data", requestId: id, message: "Winds API request failed: upstream_no_data." });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not increase METAR freshness after a wall-clock rollback", async () => {
    const base = await completeFlightWeatherClient.fetchMetar("KORD");
    const payload = { ...base, provenance: { ...base.provenance, fetchedAt: base.metar.fetchedAt, cache: { ...base.provenance.cache,
      key: "v1:metar:KORD", fetchedAt: base.metar.fetchedAt, servedAt: base.metar.fetchedAt, ageSeconds: 0,
      expiresAt: "2026-09-21T21:50:00.000Z", freshnessRemainingSeconds: 1200, maxPayloadAgeSeconds: 7200 } } };
    const api = new WorkerWindsClient({ fetch: async () => json(payload) }, "https://worksheet.invalid");
    await api.fetchMetar("KORD");
    vi.setSystemTime(new Date("2026-09-21T21:29:00.000Z"));
    await expect(api.fetchMetar("KORD")).resolves.toMatchObject({ provenance: { cache: { freshnessRemainingSeconds: 1200 } } });
  });

  it("shares the bounded success-entry budget across METAR and point resources", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/metar/")) {
        const icao = url.pathname.split("/").at(-1)!;
        const fetchedAt = "2026-09-21T21:30:00.000Z";
        const cache = { status: "upstream_refresh", source: "upstream", ageSeconds: 0, fetchedAt, expiresAt: "2026-09-21T21:50:00.000Z", freshnessRemainingSeconds: 1200, servedAt: fetchedAt, ttlSeconds: 1200, maxPayloadAgeSeconds: 7200, key: `v1:metar:${icao}`, resource: "metar" };
        return json({ metar: { icao, metarRaw: "TEST", wind: { raw: "18010KT", directionType: "fixed", directionDegTrue: 180, directionVariation: null, speedKt: 10, gustKt: null }, source: "aviationweather", fetchedAt, observedAt: fetchedAt }, provenance: { adapter: "runway-picker", fetchedAt, cache }, requestId: id });
      }
      return json(point());
    });
    const api = new WorkerWindsClient({ fetch }, "https://worksheet.invalid");
    for (let i = 0; i < 128; i++) await api.fetchMetar(String(i).padStart(4, "0"));
    await api.fetchPoint(query);
    await api.fetchMetar("0000");
    expect(fetch).toHaveBeenCalledTimes(130);
  });

  it("normalizes METAR ICAO and rejects a report for a different station", async () => {
    const payload = await completeFlightWeatherClient.fetchMetar("KORD");
    const { api } = client(payload);
    expect(await api.fetchMetar(" kord ")).toEqual(payload);
    await expect(api.fetchMetar("KJVL")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
  it.each([
    { ...query, latitudeDeg: 91 }, { ...query, altitudeFeetMsl: 2999 },
    { ...query, longitudeDeg: Number.NaN }, { ...query, plannedUtc: "2026-02-30T22:00:00.000Z" },
  ])("blocks invalid point inputs before fetching: %j", async (input) => {
    const { api, fetch } = client(point());
    await expect(api.fetchPoint(input)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("blocks malformed ICAO and unsafe base URL schemes", async () => {
    const { api, fetch } = client(point());
    await expect(api.fetchMetar("../KORD")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fetch).not.toHaveBeenCalled();
    expect(() => new WorkerWindsClient({ fetch }, "file:///tmp/weather")).toThrow("HTTP(S)");
  });
  it.each([
    { ...point(), query: { ...query, longitudeDeg: -89 } },
    { ...point(), query: undefined },
    { ...point(), query: null },
    { ...point(), windSpeedKt: 200 }, { ...point(), windFromDegTrue: null },
    { ...point(), useUntil: query.plannedUtc }, { ...point(), issuedAt: "2026-09-22T01:00:00.000Z" },
    { ...point(), sources: [] },
    { ...point(), sources: [{ ...point().sources[0]!, horizontalWeight: 0.5 }] },
    { ...point(), sources: [{ ...point().sources[0]!, temperatureVerticalWeight: 2 }] },
    { ...point(), extra: "unexpected" },
  ])("rejects mismatched, stale or malformed point evidence: %j", async (value) => {
    await expect(client(value).api.fetchPoint(query)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
  it("accepts calm wind and unavailable temperature with complete provenance", async () => {
    const value = { ...point(), windFromDegTrue: null, windSpeedKt: 0, temperatureC: null,
      sources: [{ ...point().sources[0]!, temperatureLowerAltitudeFeet: null, temperatureUpperAltitudeFeet: null,
        temperatureVerticalWeight: null, temperatureLowerC: null, temperatureUpperC: null }] };
    expect(await client(value).api.fetchPoint(query)).toEqual(value);
  });
  it("accepts rounded zero freshness while the explicit refresh deadline is still ahead", async () => {
    vi.setSystemTime(new Date("2026-09-21T22:29:59.000Z"));
    const value = { ...point(), product: { ...point().product, cache: { ...point().product.cache, freshnessRemainingSeconds: 0 } } };
    await expect(client(value).api.fetchPoint(query)).resolves.toMatchObject({ product: { cache: { freshnessRemainingSeconds: 0 } } });
  });
  it("accepts exact-query product and catalog grace independently with zero freshness", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T22:30:30.000Z"));
    const base = point();
    const stale = { ...base.product.cache, status: "stale_on_error", source: "stale", freshnessRemainingSeconds: 0,
      ageSeconds: 3630, servedAt: "2026-09-21T22:30:30.000Z" };
    const value = { ...base, product: { ...base.product, cache: stale } };
    await expect(client(value).api.fetchPoint(query)).resolves.toMatchObject({ product: { cache: { status: "stale_on_error" } } });
    vi.setSystemTime(new Date("2026-09-22T21:30:30.000Z"));
    const catalogStale = { ...base.catalog.cache, status: "stale_on_error", source: "stale", freshnessRemainingSeconds: 0, ageSeconds: 86430, maxPayloadAgeSeconds: 86520,
      checkedAt: "2026-09-21T21:30:00.000Z", refreshAfter: "2026-09-22T21:30:00.000Z", expiresAt: "2026-09-22T21:30:00.000Z", staleUntil: "2026-09-22T21:32:00.000Z",
      servedAt: "2026-09-22T21:30:30.000Z" };
    const productFresh = { ...base.product.cache, checkedAt: "2026-09-22T21:30:30.000Z", refreshAfter: "2026-09-22T22:30:30.000Z",
      staleUntil: "2026-09-22T22:32:30.000Z", expiresAt: "2026-09-22T22:30:30.000Z", freshnessRemainingSeconds: 3600,
      ageSeconds: 86430, maxPayloadAgeSeconds: 90150, servedAt: "2026-09-22T21:30:30.000Z" };
    await expect(client({ ...base, product: { ...base.product, cache: productFresh }, catalog: { cache: catalogStale } }).api.fetchPoint(query))
      .resolves.toMatchObject({ catalog: { cache: { status: "stale_on_error" } } });
  });
  it("rejects grace at staleUntil and inconsistent catalog deadlines", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T22:32:00.000Z"));
    const base = point();
    const stale = { ...base.product.cache, status: "stale_on_error", source: "stale", freshnessRemainingSeconds: 0, ageSeconds: 3720,
      servedAt: "2026-09-21T22:32:00.000Z" };
    await expect(client({ ...base, product: { ...base.product, cache: stale } }).api.fetchPoint(query)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(client({ ...base, catalog: { cache: { ...base.catalog.cache, refreshAfter: "2026-09-22T21:31:00.000Z" } } }).api.fetchPoint(query)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
  it("rejects a grace response that crosses staleUntil before client receipt", async () => {
    const base = point();
    const stale = { ...base.product.cache, status: "stale_on_error", source: "stale", freshnessRemainingSeconds: 0,
      ageSeconds: 3710, servedAt: "2026-09-21T22:31:50.000Z" };
    vi.setSystemTime(new Date("2026-09-21T22:31:59.000Z"));
    const api = new WorkerWindsClient({ fetch: async () => {
      vi.setSystemTime(new Date("2026-09-21T22:32:01.000Z"));
      return json({ ...base, product: { ...base.product, cache: stale } });
    } }, "https://worksheet.invalid");
    await expect(api.fetchPoint(query)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
  it("retains structured API failure context without exposing response text", async () => {
    await expect(client({ code: "rate_limited", error: "not echoed", requestId: id }, 429).api.fetchPoint(query))
      .rejects.toMatchObject({ code: "API_FAILURE", apiCode: "rate_limited", requestId: id });
    await expect(client({ unexpected: true }, 500).api.fetchPoint(query)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
  it("honors Retry-After only for the failed exact key and preserves WindsClientError context", async () => {
    let attempts = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      attempts += 1;
      if (attempts === 1) return new Response(JSON.stringify({ code: "upstream_no_data", error: "hidden", requestId: id }), { status: 503, headers: { "Content-Type": "application/json", "Retry-After": "2" } });
      const answer = point();
      if (new URL(String(input)).searchParams.get("altitudeFeetMsl") === "5000") answer.query = { ...query, altitudeFeetMsl: 5000 };
      return json(answer);
    });
    const api = new WorkerWindsClient({ fetch }, "https://worksheet.invalid");
    await expect(api.fetchPoint(query)).rejects.toMatchObject({ code: "API_FAILURE", apiCode: "upstream_no_data", requestId: id });
    await expect(api.fetchPoint(query)).rejects.toMatchObject({ code: "API_FAILURE", apiCode: "upstream_no_data", requestId: id });
    expect(fetch).toHaveBeenCalledTimes(1);
    await api.fetchPoint({ ...query, altitudeFeetMsl: 5000 });
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2_000);
    await api.fetchPoint(query);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    new Response("not json", { headers: { "Content-Type": "text/html" } }),
    new Response("{broken", { headers: { "Content-Type": "application/json" } }),
    new Response(null, { headers: { "Content-Type": "application/json" } }),
    new Response("{}", { headers: { "Content-Type": "application/json", "Content-Length": "524289" } }),
    new Response('"' + "x".repeat(524289) + '"', { headers: { "Content-Type": "application/json" } }),
  ])("rejects invalid or oversized response bodies", async (response) => {
    const api = new WorkerWindsClient({ fetch: async () => response }, "https://worksheet.invalid");
    await expect(api.fetchPoint(query)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
  it("reports transport failures and aborts a stalled request at the deadline", async () => {
    const failure = new WorkerWindsClient({ fetch: async () => { throw new Error("network"); } }, "https://worksheet.invalid");
    await expect(failure.fetchPoint(query)).rejects.toMatchObject({ code: "TRANSPORT_FAILURE" });
    vi.useFakeTimers();
    const stalled = new WorkerWindsClient({ fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }) }, "https://worksheet.invalid");
    const result = expect(stalled.fetchPoint(query)).rejects.toMatchObject({ code: "TRANSPORT_FAILURE" });
    await vi.advanceTimersByTimeAsync(20000);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });
});
