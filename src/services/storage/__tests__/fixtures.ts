import type { AircraftProfile } from "../../../domain/aircraft";
import { coordinate as makeCoordinate } from "../../../domain/coordinates";
import type { PlanningValue } from "../../../domain/planning-value";
import type { PlanDraft, PlanFamily, PlanRevision, RouteDefinition, WeatherReferenceSnapshot } from "../../../domain/route";
import type { NavlogExportBundle } from "../contracts";

export const timestamp = "2026-09-21T12:00:00.000Z";

function coordinate(latitude: number, longitude: number) {
  const result = makeCoordinate(latitude, longitude);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

export const aircraftProfile = (): AircraftProfile => ({
  schemaVersion: 1,
  id: "aircraft-1",
  name: "Study Cessna",
  cruiseTasKnots: 95,
  cruiseFuelFlowGallonsPerHour: 6,
  climbRateFeetPerMinute: 500,
  climbTasKnots: 75,
  climbFuelFlowGallonsPerHour: 7,
  descentRateFeetPerMinute: 500,
  descentTasKnots: 100,
  descentFuelFlowGallonsPerHour: 5,
  usableFuelGallons: 24,
  compassDeviationTable: [{ magneticHeadingDegrees: 90, deviationDegrees: 1 }],
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const aircraftDefaultValue = (effectiveValue = 4_500): PlanningValue<number> => ({
  computedValue: effectiveValue,
  effectiveValue,
  origin: "aircraft-default",
  provenance: {
    sourceId: "aircraft-1",
    sourceLabel: "Study Cessna",
    recordedAt: timestamp,
  },
});

export const route = (): RouteDefinition => ({
  id: "route-1",
  points: [
    {
      kind: "airport",
      id: "departure-1",
      icao: "KORD",
      name: "Chicago O'Hare",
      coordinate: coordinate(41.9742, -87.9073),
      elevationFeetMsl: 680,
    },
    {
      kind: "checkpoint",
      id: "checkpoint-1",
      name: "Study checkpoint",
      coordinate: coordinate(41.8, -88.2),
    },
    {
      kind: "airport",
      id: "destination-1",
      icao: "KJVL",
      name: "Southern Wisconsin Regional",
      coordinate: coordinate(42.62, -89.04),
      elevationFeetMsl: 808,
    },
  ],
  legs: [
    { id: "leg-1", fromPointId: "departure-1", toPointId: "checkpoint-1", cruiseAltitudeFeetMsl: 4_500 },
    { id: "leg-2", fromPointId: "checkpoint-1", toPointId: "destination-1", cruiseAltitudeFeetMsl: 4_500 },
  ],
});

export const planDraft = (): PlanDraft => ({
  schemaVersion: 1,
  id: "draft-1",
  planId: "plan-1",
  title: "KORD to KJVL study route",
  departureTimeUtc: "2030-09-21T12:00:00.000Z",
  route: route(),
  selectedAircraftProfileId: "aircraft-1",
  fuelInputs: { taxiRunupFuelGallons: 0, reserveFuelGallons: 3 },
  descentTargetAltitudeFeetMsl: aircraftDefaultValue(1_808),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const planFamily = (): PlanFamily => ({
  schemaVersion: 1,
  id: "plan-1",
  title: "KORD to KJVL study route",
  createdAt: timestamp,
  latestRevisionId: "revision-1",
});

export const weatherSnapshot = (): WeatherReferenceSnapshot => ({
  schemaVersion: 1,
  id: "weather-1",
  retrievedAt: timestamp,
  source: "fixture",
  payload: { raw: "METAR KORD 211200Z" },
});

export const planRevision = (): PlanRevision => ({
  schemaVersion: 1,
  id: "revision-1",
  planId: "plan-1",
  reason: "initial-save",
  createdAt: timestamp,
  draftSnapshot: planDraft(),
  aircraftProfileSnapshot: { profile: aircraftProfile(), snapshottedAt: timestamp },
  weatherSnapshotIds: ["weather-1"],
  calculationSnapshot: { version: "not-calculated" },
  warnings: [],
});

export const exportBundle = (): NavlogExportBundle => ({
  format: "ppl-navlog/export",
  formatVersion: 1,
  exportedAt: timestamp,
  aircraftProfiles: [aircraftProfile()],
  planFamilies: [planFamily()],
  planRevisions: [planRevision()],
  weatherSnapshots: [weatherSnapshot()],
});
