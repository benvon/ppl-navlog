import { describe, expect, it } from "vitest";

import type { MetarSuccessPayload, WindsForecastSuccessPayload, WindsStationsSuccessPayload } from "../../../worker/api/contracts";
import { coordinate } from "../../domain/coordinates";
import { feetMsl, nauticalMiles } from "../../domain/units";
import { WorkerWindsAdapter, createSampledPhaseWindResolver, resolveLoadedEffectiveWindForSubleg, resolveLoadedWindAtAltitude, sampleLoadedEffectivePhaseWind } from "./winds-adapter";
import { WorkerWindsClient, WindsClientError, type BrowserFetch, type WindsTransportClient } from "./winds-client";

const value = <T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T => {
  if (!result.ok) throw new Error("Expected successful result.");
  return result.value;
};

const cache = {
  status: "upstream_refresh" as const,
  source: "upstream" as const,
  ageSeconds: 0,
  fetchedAt: "2026-09-21T18:30:00.000Z",
  expiresAt: "2026-09-21T18:50:00.000Z",
  freshnessRemainingSeconds: 1200,
  servedAt: "2026-09-21T18:30:00.000Z",
  ttlSeconds: 1200,
  maxPayloadAgeSeconds: 7200,
  key: "winds/us/06",
  resource: "winds-temps",
};

const sourceProvenance = {
  adapter: "aviationweather" as const,
  product: "NCEP FB Winds/Temps (legacy FD)" as const,
  region: "us" as const,
  endpoint: "https://aviationweather.gov/api/data/windtemp" as const,
  fetchedAt: "2026-09-21T18:30:00.000Z",
  cache,
};

const discoveryPayload = (): WindsStationsSuccessPayload => ({
  stations: [
    {
      id: "BRL", name: "Burlington", coordinates: { latitudeDeg: 40.7832, longitudeDeg: -91.1255 }, elevationFt: 698,
      region: "us", availableForecastCycles: ["06"], source: "aviationweather",
    },
    {
      id: "DBQ", name: "Dubuque", coordinates: { latitudeDeg: 42.402, longitudeDeg: -90.7095 }, elevationFt: 1076,
      region: "us", availableForecastCycles: ["06"], source: "aviationweather",
    },
  ],
  forecasts: [{
    stationId: "BRL", forecastCycle: "06", issuedAt: "2026-09-21T18:00:00.000Z", validAt: "2026-09-22T00:00:00.000Z",
    useFrom: "2026-09-21T20:00:00.000Z", useUntil: "2026-09-22T03:00:00.000Z",
  }, {
    stationId: "DBQ", forecastCycle: "06", issuedAt: "2026-09-21T18:00:00.000Z", validAt: "2026-09-22T00:00:00.000Z",
    useFrom: "2026-09-21T20:00:00.000Z", useUntil: "2026-09-22T03:00:00.000Z",
  }],
  unavailableForecastCycles: [],
  requestedRoute: [{ latitudeDeg: 40.8, longitudeDeg: -91.1 }],
  provenance: [sourceProvenance],
  requestId: "11111111-1111-4111-8111-111111111111",
});

const forecastPayload = (): WindsForecastSuccessPayload => ({
  forecast: {
    station: discoveryPayload().stations[0]!, forecastCycle: "06", issuedAt: "2026-09-21T18:00:00.000Z",
    validAt: "2026-09-22T00:00:00.000Z", useFrom: "2026-09-21T20:00:00.000Z", useUntil: "2026-09-22T03:00:00.000Z",
    levels: [
      { altitudeFt: 3000, windFromDegTrue: null, windSpeedKt: 0, temperatureC: null, availability: "available", raw: "9900" },
      { altitudeFt: 6000, windFromDegTrue: 270, windSpeedKt: 20, temperatureC: 2, availability: "available", raw: "2720+02" },
      { altitudeFt: 9000, windFromDegTrue: 90, windSpeedKt: 20, temperatureC: -2, availability: "available", raw: "0920-02" },
      { altitudeFt: 12000, windFromDegTrue: null, windSpeedKt: null, temperatureC: null, availability: "unavailable", raw: "////" },
    ],
    rawProduct: "official product text", source: "aviationweather", fetchedAt: "2026-09-21T18:30:00.000Z",
  },
  provenance: sourceProvenance,
  requestId: "22222222-2222-4222-8222-222222222222",
});

const metarPayload = (): MetarSuccessPayload => ({
  metar: {
    icao: "KJVL",
    metarRaw: "KJVL 212130Z 18010KT 10SM FEW050 25/12 A3002 RMK AO2",
    wind: { raw: "18010KT", directionType: "fixed", directionDegTrue: 180, directionVariation: null, speedKt: 10, gustKt: null },
    source: "aviationweather",
    fetchedAt: "2026-09-21T21:31:00.000Z",
    observedAt: "2026-09-21T21:30:00.000Z",
  },
  provenance: {
    adapter: "runway-picker",
    fetchedAt: "2026-09-21T21:31:00.000Z",
    cache: { ...cache, key: "metar:KJVL", resource: "metar", fetchedAt: "2026-09-21T21:31:00.000Z", servedAt: "2026-09-21T21:31:00.000Z", expiresAt: "2026-09-21T21:46:00.000Z" },
  },
  requestId: "33333333-3333-4333-8333-333333333333",
});

class FakeWindsClient implements WindsTransportClient {
  public constructor(
    private readonly discovery: WindsStationsSuccessPayload = discoveryPayload(),
    private readonly forecast: WindsForecastSuccessPayload = forecastPayload(),
  ) {}

  public async discoverStations(): Promise<WindsStationsSuccessPayload> { return structuredClone(this.discovery); }
  public async fetchForecast(): Promise<WindsForecastSuccessPayload> { return structuredClone(this.forecast); }
}

describe("WorkerWindsClient trust boundary", () => {
  it("uses canonical route query coordinates and parses the documented discovery contract", async () => {
    const requests: URL[] = [];
    const fetcher: BrowserFetch = {
      async fetch(input): Promise<Response> {
        requests.push(new URL(input.toString()));
        return Response.json(discoveryPayload());
      },
    };
    const client = new WorkerWindsClient(fetcher, "https://navlog.example");
    await expect(client.discoverStations([value(coordinate(0.0000001, -88.7))])).resolves.toMatchObject({ requestId: expect.any(String) });
    expect(requests[0]?.pathname).toBe("/api/weather/winds/stations");
    expect(requests[0]?.searchParams.get("route")).toBe("0.0000001,-88.7");
  });

  it("rejects a noncanonical timestamp in an otherwise successful response", async () => {
    const invalid = discoveryPayload();
    invalid.forecasts[0] = { ...invalid.forecasts[0]!, validAt: "2026-02-30T00:00:00.000Z" };
    const client = new WorkerWindsClient({ fetch: async () => Response.json(invalid) }, "https://navlog.example");
    await expect(client.discoverStations([value(coordinate(40.8, -91.1))])).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("rejects station-period records with unknown station IDs or duplicate station-time identities", async () => {
    const wrongStation = discoveryPayload();
    wrongStation.forecasts[0] = { ...wrongStation.forecasts[0]!, stationId: "XYZ" };
    const wrongStationClient = new WorkerWindsClient({ fetch: async () => Response.json(wrongStation) }, "https://navlog.example");
    await expect(wrongStationClient.discoverStations([value(coordinate(40.8, -91.1))])).rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    const duplicate = discoveryPayload();
    duplicate.forecasts.push({ ...duplicate.forecasts[0]! });
    const duplicateClient = new WorkerWindsClient({ fetch: async () => Response.json(duplicate) }, "https://navlog.example");
    await expect(duplicateClient.discoverStations([value(coordinate(40.8, -91.1))])).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("normalizes local forecast input and validates the forecast response contract", async () => {
    const requests: URL[] = [];
    const fetcher: BrowserFetch = {
      async fetch(input): Promise<Response> {
        requests.push(new URL(input.toString()));
        return Response.json(forecastPayload());
      },
    };
    const client = new WorkerWindsClient(fetcher, "https://navlog.example");
    await expect(client.fetchForecast(" brl ", "2026-09-22T00:00:00.000Z", "us")).resolves.toMatchObject({
      forecast: { station: { id: "BRL" } },
    });
    expect(requests[0]?.searchParams).toMatchObject({});
    expect(requests[0]?.searchParams.get("station")).toBe("BRL");
    expect(requests[0]?.searchParams.get("validTime")).toBe("2026-09-22T00:00:00.000Z");
  });

  it("loads a validated METAR from the existing Worker contract", async () => {
    const requests: URL[] = [];
    const fetcher: BrowserFetch = {
      async fetch(input): Promise<Response> {
        requests.push(new URL(input.toString()));
        return Response.json(metarPayload());
      },
    };
    const client = new WorkerWindsClient(fetcher, "https://navlog.example");
    await expect(client.fetchMetar(" kjvl ")).resolves.toMatchObject({ metar: { icao: "KJVL", wind: { directionDegTrue: 180 } } });
    expect(requests[0]?.pathname).toBe("/api/weather/metar/KJVL");
  });

  it("rejects invalid local inputs before a request is made", async () => {
    let requests = 0;
    const client = new WorkerWindsClient({ fetch: async () => { requests += 1; return Response.json(discoveryPayload()); } }, "https://navlog.example");
    await expect(client.discoverStations([])).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(client.fetchForecast("XX", "2026-09-22T00:00:00.000Z", "us")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(client.fetchForecast("BRL", "2026-02-30T00:00:00.000Z", "us")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(client.fetchForecast("BRL", "2026-09-22T00:00:00.000Z", "outside-v1" as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(client.fetchMetar("JVL")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(client.discoverStations([{ latitude: Number.NaN, longitude: 0 } as never])).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(requests).toBe(0);
  });

  it("maps valid API errors, malformed failures, bad JSON, absent bodies, and transport failure distinctly", async () => {
    const apiFailure = new WorkerWindsClient({
      fetch: async () => Response.json({ error: "No data", code: "upstream_no_data", requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, { status: 404 }),
    }, "https://navlog.example");
    await expect(apiFailure.discoverStations([value(coordinate(40.8, -91.1))])).rejects.toMatchObject({
      code: "API_FAILURE", requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });

    const malformedFailure = new WorkerWindsClient({ fetch: async () => Response.json({ nope: true }, { status: 500 }) }, "https://navlog.example");
    await expect(malformedFailure.discoverStations([value(coordinate(40.8, -91.1))])).rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    const invalidJson = new WorkerWindsClient({
      fetch: async () => new Response("not json", { headers: { "Content-Type": "application/json" } }),
    }, "https://navlog.example");
    await expect(invalidJson.discoverStations([value(coordinate(40.8, -91.1))])).rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    const missingBody = new WorkerWindsClient({
      fetch: async () => new Response(null, { headers: { "Content-Type": "application/json" } }),
    }, "https://navlog.example");
    await expect(missingBody.discoverStations([value(coordinate(40.8, -91.1))])).rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    const transportFailure = new WorkerWindsClient({ fetch: async () => { throw new Error("offline"); } }, "https://navlog.example");
    await expect(transportFailure.discoverStations([value(coordinate(40.8, -91.1))])).rejects.toMatchObject({ code: "TRANSPORT_FAILURE" });
  });

  it("caps an oversized chunked response before parsing JSON", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(512 * 1024 + 1));
        controller.close();
      },
    });
    const client = new WorkerWindsClient({
      fetch: async () => new Response(body, { headers: { "Content-Type": "application/json" } }),
    }, "https://navlog.example");
    await expect(client.discoverStations([value(coordinate(40.8, -91.1))])).rejects.toBeInstanceOf(WindsClientError);
  });
});

describe("WorkerWindsAdapter", () => {
  const input = {
    routeCoordinates: [value(coordinate(40.8, -91.1))],
    stationSelectionCoordinate: value(coordinate(40.8, -91.1)),
    selectedForecastValidTimeUtc: "2026-09-22T00:00:00.000Z",
    departureTimeUtc: "2026-09-21T22:00:00.000Z",
  };

  it("preserves source evidence while selecting, normalizing calm, and sampling winds", async () => {
    const loaded = await new WorkerWindsAdapter(new FakeWindsClient()).load(input);
    expect(loaded.stationSelection.station.id).toBe("BRL");
    expect(loaded.forecastSelection.period.id).toBe("2026-09-22T00:00:00.000Z");
    expect(loaded.levelEvidence.map((level) => level.directionTreatment)).toEqual([
      "calm-normalized-to-000", "published-direction", "published-direction", "unavailable",
    ]);
    expect(loaded.provenance.requestIds).toEqual({
      stationDiscovery: "11111111-1111-4111-8111-111111111111",
      forecast: "22222222-2222-4222-8222-222222222222",
    });
    const exact = value(resolveLoadedWindAtAltitude(loaded, 3000));
    expect(exact.wind).toMatchObject({ directionFrom: 0, speed: 0 });
    const effective = value(sampleLoadedEffectivePhaseWind(loaded, 3000, 9000));
    expect(effective.samples).toHaveLength(5);
    expect(effective.samples.map((sample) => sample.altitude)).toEqual([3000, 4500, 6000, 7500, 9000]);
    const resolver = createSampledPhaseWindResolver(loaded);
    const resolved = resolver.resolveEffectiveWind({
      phase: "climb", start: input.stationSelectionCoordinate, courseDegreesTrue: 90, startingAltitudeFeetMsl: 3000,
      targetAltitudeFeetMsl: 9000, estimatedDistanceNauticalMiles: value(nauticalMiles(0)), iteration: 1,
    });
    expect(resolved).toMatchObject({ ok: true });
  });

  it("refuses to extrapolate below the published winds-aloft envelope", async () => {
    const loaded = await new WorkerWindsAdapter(new FakeWindsClient()).load(input);
    expect(sampleLoadedEffectivePhaseWind(loaded, 1000, 3000)).toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED_WIND_ALTITUDE" },
    });
    expect(resolveLoadedWindAtAltitude(loaded, value(feetMsl(1000)))).toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED_WIND_ALTITUDE" },
    });
  });

  it("uses a fresh fixed-direction METAR at departure field elevation and exposes the planning assumption", async () => {
    const loaded = await new WorkerWindsAdapter(new FakeWindsClient()).load({
      ...input,
      departureSurfaceWind: { airportIcao: "KJVL", fieldElevationFeetMsl: 808, metar: metarPayload() },
    });
    expect(loaded.availableLevels.map((level) => level.altitude)).toEqual([808, 3000, 6000, 9000]);
    expect(loaded.surfaceToAloftInterpolation).toMatchObject({
      status: "applied",
      assumption: "metar-at-field-elevation-vector-interpolated-to-first-fb-level",
      statement: expect.stringContaining("surface METAR KJVL"),
      fieldElevationFeetMsl: 808,
      directionTreatment: "fixed-true",
      firstAloftLevel: { transport: { altitudeFt: 3000 } },
      metar: { metarRaw: expect.stringContaining("18010KT"), requestId: "33333333-3333-4333-8333-333333333333" },
    });
    expect(loaded.surfaceToAloftInterpolation?.statement).toContain("departure airport KJVL field elevation 808 ft MSL");
    const surface = value(resolveLoadedWindAtAltitude(loaded, 808));
    expect(surface.wind).toMatchObject({ directionFrom: 180, speed: 10 });
    const effective = value(sampleLoadedEffectivePhaseWind(loaded, 808, 6000));
    expect(effective.surfaceToAloftInterpolation).toMatchObject({ status: "applied" });
    const directCruise = value(resolveLoadedEffectiveWindForSubleg(loaded, 6000, 6000));
    expect(directCruise).toMatchObject({ method: "direct-altitude-resolution", wind: { directionFrom: 270, speed: 20 } });
    expect(directCruise.surfaceToAloftInterpolation).toBeUndefined();
    const climbingSubleg = value(resolveLoadedEffectiveWindForSubleg(loaded, 808, 6000));
    expect(climbingSubleg).toMatchObject({ method: "sampled-phase-wind", surfaceToAloftInterpolation: { status: "applied" } });
  });

  it("does not turn calm, variable, stale, or unavailable METAR evidence into a surface vector", async () => {
    const base = metarPayload();
    const cases = [
      {
        metar: { ...base, metar: { ...base.metar, wind: { raw: "00000KT", directionType: "calm" as const, directionDegTrue: null, directionVariation: null, speedKt: 0, gustKt: null } } },
        expected: "calm-normalized-to-000",
      },
      {
        metar: { ...base, metar: { ...base.metar, wind: { raw: "VRB05KT", directionType: "variable" as const, directionDegTrue: null, directionVariation: { fromDegTrue: 120, toDegTrue: 220 }, speedKt: 5, gustKt: null } } },
        expected: "variable-direction",
      },
      {
        metar: { ...base, provenance: { ...base.provenance, cache: { ...base.provenance.cache, status: "stale_on_error" as const, source: "stale" as const, freshnessRemainingSeconds: 0 } } },
        expected: "stale-cache-response",
      },
      {
        metar: { ...base, metar: { ...base.metar, observedAt: null } },
        expected: "observation-time-unavailable",
      },
    ] as const;
    for (const testCase of cases) {
      const loaded = await new WorkerWindsAdapter(new FakeWindsClient()).load({
        ...input,
        departureSurfaceWind: { airportIcao: "KJVL", fieldElevationFeetMsl: 808, metar: testCase.metar },
      });
      if (testCase.expected === "calm-normalized-to-000") {
        expect(loaded.surfaceToAloftInterpolation).toMatchObject({ status: "applied", directionTreatment: testCase.expected });
        expect(loaded.availableLevels[0]).toMatchObject({ altitude: 808, wind: { speed: 0 } });
      } else {
        expect(loaded.surfaceToAloftInterpolation).toMatchObject({ status: "unavailable", reason: testCase.expected });
        expect(loaded.availableLevels[0]).toMatchObject({ altitude: 3000 });
      }
    }
  });

  it("rejects an ambiguous selected discovery period and changed forecast use window", async () => {
    const ambiguous = discoveryPayload();
    ambiguous.forecasts = [...ambiguous.forecasts, { ...ambiguous.forecasts[0]!, forecastCycle: "12" }];
    await expect(new WorkerWindsAdapter(new FakeWindsClient(ambiguous)).load(input)).rejects.toMatchObject({ code: "SELECTION" });

    const changed = forecastPayload();
    changed.forecast = { ...changed.forecast, useUntil: "2026-09-22T04:00:00.000Z" };
    await expect(new WorkerWindsAdapter(new FakeWindsClient(discoveryPayload(), changed)).load(input)).rejects.toMatchObject({
      code: "INVALID_FORECAST",
    });
  });

  it("uses only periods belonging to the deterministic nearest station", async () => {
    const discovery = discoveryPayload();
    const distantOnly = { ...discovery.forecasts[0]!, stationId: "DBQ", validAt: "2026-09-22T06:00:00.000Z", forecastCycle: "12" as const, useFrom: "2026-09-22T02:00:00.000Z", useUntil: "2026-09-22T09:00:00.000Z" };
    discovery.forecasts = [...discovery.forecasts, distantOnly];
    const client = new FakeWindsClient(discovery);
    const loaded = await new WorkerWindsAdapter(client).load(input);
    expect(loaded.stationSelection.station.id).toBe("BRL");
    await expect(new WorkerWindsAdapter(client).load({ ...input, selectedForecastValidTimeUtc: distantOnly.validAt })).rejects.toMatchObject({ code: "SELECTION" });
  });

  it("does not turn transport, unusable levels, or malformed calm data into a calculated wind", async () => {
    const failedClient: WindsTransportClient = {
      discoverStations: async () => { throw new Error("offline"); },
      fetchForecast: async () => forecastPayload(),
    };
    await expect(new WorkerWindsAdapter(failedClient).load(input)).rejects.toMatchObject({ code: "TRANSPORT" });

    const noUsable = forecastPayload();
    noUsable.forecast = { ...noUsable.forecast, levels: [{ altitudeFt: 3000, windFromDegTrue: null, windSpeedKt: null, temperatureC: null, availability: "unavailable", raw: "////" }] };
    await expect(new WorkerWindsAdapter(new FakeWindsClient(discoveryPayload(), noUsable)).load(input)).rejects.toMatchObject({ code: "NO_USABLE_LEVELS" });

    const invalidCalm = forecastPayload();
    invalidCalm.forecast = { ...invalidCalm.forecast, levels: [{ altitudeFt: 3000, windFromDegTrue: null, windSpeedKt: 5, temperatureC: null, availability: "available", raw: "0005" }] };
    await expect(new WorkerWindsAdapter(new FakeWindsClient(discoveryPayload(), invalidCalm)).load(input)).rejects.toMatchObject({ code: "INVALID_FORECAST" });
  });

  it("rejects changed station identity and an unadvertised returned forecast cycle", async () => {
    const changedStation = forecastPayload();
    changedStation.forecast = {
      ...changedStation.forecast,
      station: { ...changedStation.forecast.station, coordinates: { latitudeDeg: 42, longitudeDeg: -90 } },
    };
    await expect(new WorkerWindsAdapter(new FakeWindsClient(discoveryPayload(), changedStation)).load(input)).rejects.toMatchObject({ code: "INVALID_FORECAST" });

    const unadvertisedCycle = forecastPayload();
    unadvertisedCycle.forecast = {
      ...unadvertisedCycle.forecast,
      station: { ...unadvertisedCycle.forecast.station, availableForecastCycles: ["12"] },
    };
    await expect(new WorkerWindsAdapter(new FakeWindsClient(discoveryPayload(), unadvertisedCycle)).load(input)).rejects.toMatchObject({ code: "INVALID_FORECAST" });
  });

  it("fetches and strictly validates one point answer against its exact query", async () => {
    const query = { latitudeDeg: 42.6, longitudeDeg: -89, altitudeFeetMsl: 4500, plannedUtc: "2026-09-22T01:00:00.000Z" };
    const answer = {
      query, windFromDegTrue: 350.5, windSpeedKt: 14, temperatureC: -2, issuedAt: "2026-09-21T20:00:00.000Z", useFrom: "2026-09-22T00:00:00.000Z", useUntil: "2026-09-22T03:00:00.000Z", forecastCycle: "06",
      sources: [{ stationId: "BRL", latitudeDeg: 40.78, longitudeDeg: -91.12, distanceNauticalMiles: 1, horizontalWeight: 1, lowerAltitudeFeet: 3000, upperAltitudeFeet: 6000, verticalWeight: 0.5, lowerWindFromDegTrue: 270, lowerWindSpeedKt: 10, upperWindFromDegTrue: 280, upperWindSpeedKt: 15, temperatureLowerAltitudeFeet: 3000, temperatureUpperAltitudeFeet: 6000, temperatureVerticalWeight: 0.5, temperatureLowerC: 5, temperatureUpperC: 0 }],
      method: "horizontal-vertical-vector", requestId: "11111111-1111-4111-8111-111111111111",
    };
    const client = new WorkerWindsClient({ fetch: async () => Response.json(answer) }, "https://navlog.example");
    await expect(client.fetchPoint(query)).resolves.toMatchObject({ query, windSpeedKt: 14 });
    const mismatched = new WorkerWindsClient({ fetch: async () => Response.json({ ...answer, query: { ...query, altitudeFeetMsl: 5000 } }) }, "https://navlog.example");
    await expect(mismatched.fetchPoint(query)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    const invalidWeight = new WorkerWindsClient({ fetch: async () => Response.json({ ...answer, sources: [{ ...answer.sources[0], horizontalWeight: 2 }] }) }, "https://navlog.example");
    await expect(invalidWeight.fetchPoint(query)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    const nullDirection = new WorkerWindsClient({ fetch: async () => Response.json({ ...answer, windFromDegTrue: null, windSpeedKt: 10 }) }, "https://navlog.example");
    await expect(nullDirection.fetchPoint(query)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    const badWeightSum = new WorkerWindsClient({ fetch: async () => Response.json({ ...answer, sources: [{ ...answer.sources[0], horizontalWeight: 0.4 }] }) }, "https://navlog.example");
    await expect(badWeightSum.fetchPoint(query)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    const tooManySources = new WorkerWindsClient({ fetch: async () => Response.json({ ...answer, sources: Array.from({ length: 4 }, (_, index) => ({ ...answer.sources[0]!, stationId: `BR${index}` })) }) }, "https://navlog.example");
    await expect(tooManySources.fetchPoint(query)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    const incoherentTemperature = new WorkerWindsClient({ fetch: async () => Response.json({ ...answer, sources: [{ ...answer.sources[0], temperatureLowerAltitudeFeet: null, temperatureUpperAltitudeFeet: null, temperatureVerticalWeight: 0.5 }] }) }, "https://navlog.example");
    await expect(incoherentTemperature.fetchPoint(query)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });

    const preciseQuery = { ...query, latitudeDeg: 55.123456789012, longitudeDeg: -179.123456789012 };
    const sentCoordinateLengths: number[] = [];
    const preciseClient = new WorkerWindsClient({ fetch: async (input) => {
      const url = new URL(String(input));
      const lat = url.searchParams.get("lat")!, lon = url.searchParams.get("lon")!;
      sentCoordinateLengths.push(lat.length, lon.length);
      const sentQuery = { ...query, latitudeDeg: Number(lat), longitudeDeg: Number(lon) };
      return Response.json({ ...answer, query: sentQuery });
    } }, "https://navlog.example");
    const preciseAnswer = await preciseClient.fetchPoint(preciseQuery);
    expect(preciseAnswer.query).toMatchObject({ latitudeDeg: 55.123456789, longitudeDeg: -179.123456789 });
    expect(Math.max(...sentCoordinateLengths)).toBeLessThanOrEqual(16);
  });

  it("validates TAF transport station identity and every group field", async () => {
    const payload = { stationIcao: "KORD", issuedAt: "2026-09-22T00:00:00.000Z", validFrom: "2026-09-22T00:00:00.000Z", validUntil: "2026-09-23T00:00:00.000Z", rawTaf: "TAF KORD", requestId: "11111111-1111-4111-8111-111111111111", groups: [{ kind: "prevailing", fromUtc: "2026-09-22T00:00:00.000Z", untilUtc: "2026-09-23T00:00:00.000Z", windDirectionType: "fixed", windFromDegTrue: 270, windSpeedKt: 10, gustKt: null, probabilityPercent: null, raw: "prevailing" }] };
    const valid = new WorkerWindsClient({ fetch: async () => Response.json(payload) }, "https://navlog.example");
    await expect(valid.fetchTaf("KORD")).resolves.toMatchObject({ stationIcao: "KORD" });
    const wrongStation = new WorkerWindsClient({ fetch: async () => Response.json({ ...payload, stationIcao: "KJFK" }) }, "https://navlog.example");
    await expect(wrongStation.fetchTaf("KORD")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    const malformed = { ...payload, groups: [{ ...payload.groups[0]!, windDirectionType: "variable" }] };
    await expect(new WorkerWindsClient({ fetch: async () => Response.json(malformed) }, "https://navlog.example").fetchTaf("KORD")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
