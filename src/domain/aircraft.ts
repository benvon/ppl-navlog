export const AIRCRAFT_PROFILE_SCHEMA_VERSION = 1 as const;

export interface CompassDeviationEntry {
  /** Magnetic heading in degrees, normalized to the internal range [0, 360). */
  readonly magneticHeadingDegrees: number;
  /** Signed compass deviation in degrees; east is positive and west is negative. */
  readonly deviationDegrees: number;
}

export interface AircraftProfile {
  readonly schemaVersion: typeof AIRCRAFT_PROFILE_SCHEMA_VERSION;
  readonly id: string;
  readonly name: string;
  readonly cruiseTasKnots: number;
  readonly cruiseFuelFlowGallonsPerHour: number;
  readonly climbRateFeetPerMinute: number;
  readonly climbTasKnots: number;
  readonly climbFuelFlowGallonsPerHour: number;
  readonly descentRateFeetPerMinute: number;
  readonly descentTasKnots: number;
  readonly descentFuelFlowGallonsPerHour: number;
  readonly usableFuelGallons?: number;
  readonly compassDeviationTable: readonly CompassDeviationEntry[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A value copy embedded in a revision, insulated from later profile edits. */
export interface AircraftProfileSnapshot {
  readonly profile: AircraftProfile;
  readonly snapshottedAt: string;
}

export type AircraftProfileInput = Omit<
  AircraftProfile,
  "schemaVersion" | "id" | "createdAt" | "updatedAt"
>;
