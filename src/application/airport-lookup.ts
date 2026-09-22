import { coordinate } from "../domain/coordinates";
import type { AirportRoutePoint } from "../domain/route";

export interface AirportLookup {
  lookupExactIcao(icao: string): Promise<AirportRoutePoint>;
}

export class AirportLookupError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AirportLookupError";
  }
}

/**
 * Deliberately local study data for the shell before the Worker-backed airport
 * adapter is available. It never claims to be current FAA data.
 */
export class StaticAirportLookup implements AirportLookup {
  private readonly airports: ReadonlyMap<string, AirportRoutePoint>;

  public constructor(airports: readonly AirportRoutePoint[]) {
    this.airports = new Map(airports.map((airport) => [airport.icao, airport]));
  }

  public async lookupExactIcao(icao: string): Promise<AirportRoutePoint> {
    const normalized = normalizeIcao(icao);
    const airport = this.airports.get(normalized);
    if (airport === undefined) {
      throw new AirportLookupError(`No local study airport is available for ${normalized}. Live airport lookup is not configured yet.`);
    }
    return structuredClone(airport);
  }
}

export function normalizeIcao(icao: string): string {
  const normalized = icao.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(normalized)) {
    throw new AirportLookupError("Enter a four-character ICAO identifier (for example KORD). FAA location identifiers such as 1C8 are not supported in v1.");
  }
  return normalized;
}

function knownAirport(id: string, icao: string, name: string, latitude: number, longitude: number, elevationFeetMsl: number): AirportRoutePoint {
  const checkedCoordinate = coordinate(latitude, longitude);
  if (!checkedCoordinate.ok) throw new Error(checkedCoordinate.error.message);
  return { kind: "airport", id, icao, name, coordinate: checkedCoordinate.value, elevationFeetMsl };
}

export function createLocalStudyAirportLookup(): StaticAirportLookup {
  return new StaticAirportLookup([
    knownAirport("airport-kord", "KORD", "Chicago O'Hare International", 41.9742, -87.9073, 680),
    knownAirport("airport-kjvl", "KJVL", "Southern Wisconsin Regional", 42.6203, -89.0416, 808),
  ]);
}
