import { afterEach, describe, expect, it, vi } from "vitest";
import type { AloftPointAnswer, AloftPointQuery } from "../../../worker/api/contracts";
import { completeFlightWeatherClient } from "../../test/fixtures/complete-flight";
import { WorkerWindsClient } from "./winds-client";

const query: AloftPointQuery = { latitudeDeg: 42, longitudeDeg: -88, altitudeFeetMsl: 4500, plannedUtc: "2026-09-21T22:00:00.000Z" };
const id = "44444444-4444-4444-8444-444444444444";
function point(): AloftPointAnswer {
  return {
    query, windFromDegTrue: 270, windSpeedKt: 12, temperatureC: 3,
    issuedAt: "2026-09-21T20:00:00.000Z", useFrom: "2026-09-21T21:00:00.000Z", useUntil: "2026-09-22T03:00:00.000Z",
    forecastCycle: "06", method: "station-level", requestId: id,
    product: { region: "us", cycle: "06", cache: { status: "upstream_refresh", source: "upstream", ageSeconds: 0,
      fetchedAt: "2026-09-21T21:30:00.000Z", expiresAt: "2026-09-21T21:50:00.000Z", freshnessRemainingSeconds: 1200, servedAt: "2026-09-21T21:30:00.000Z" } },
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
    { ...point(), windSpeedKt: 200 }, { ...point(), windFromDegTrue: null },
    { ...point(), useUntil: query.plannedUtc }, { ...point(), issuedAt: "2026-09-22T01:00:00.000Z" },
    { ...point(), sources: [] },
    { ...point(), sources: [{ ...point().sources[0]!, horizontalWeight: 0.5 }] },
    { ...point(), sources: [{ ...point().sources[0]!, temperatureVerticalWeight: 2 }] },
    { ...point(), product: { ...point().product, cache: { ...point().product.cache, freshnessRemainingSeconds: 0 } } },
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
  it("retains structured API failure context without exposing response text", async () => {
    await expect(client({ code: "rate_limited", error: "not echoed", requestId: id }, 429).api.fetchPoint(query))
      .rejects.toMatchObject({ code: "API_FAILURE", apiCode: "rate_limited", requestId: id });
    await expect(client({ unexpected: true }, 500).api.fetchPoint(query)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
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
    await vi.advanceTimersByTimeAsync(10000);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });
});
