/** Errors intentionally contain no transport, storage, or UI details. */
export type DomainErrorCode =
  | "INVALID_NUMBER"
  | "OUT_OF_RANGE"
  | "INVALID_COORDINATE_FORMAT"
  | "INVALID_WIND_STATION"
  | "NO_WIND_STATIONS"
  | "INVALID_FORECAST_PERIOD"
  | "FORECAST_OUTSIDE_VALIDITY"
  | "UNSUPPORTED_WIND_ALTITUDE"
  | "INVALID_WIND_SAMPLING"
  | "IDENTICAL_COORDINATES"
  | "ANTIPODAL_COORDINATES"
  | "INVALID_WIND_TRIANGLE"
  | "NONPOSITIVE_GROUNDSPEED"
  | "INVALID_DEVIATION_TABLE"
  | "NON_FINITE_RESULT"
  | "INVALID_PHASE_PERFORMANCE"
  | "INVALID_PHASE_ALTITUDES"
  | "ROUTE_GEOMETRY_ERROR"
  | "INFEASIBLE_PROFILE"
  | "NON_CONVERGENT_PHASE_GEOMETRY";

export interface DomainError {
  readonly code: DomainErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, number | string | boolean | null>>;
}

export type DomainResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DomainError };

export const success = <T>(value: T): DomainResult<T> => ({ ok: true, value });

export const failure = <T = never>(
  code: DomainErrorCode,
  message: string,
  details?: Readonly<Record<string, number | string | boolean | null>>,
): DomainResult<T> => ({ ok: false, error: { code, message, details } });

/** Preserves a structured error while changing the success type of a result. */
export const propagateFailure = <T>(result: Extract<DomainResult<unknown>, { readonly ok: false }>): DomainResult<T> => ({
  ok: false,
  error: result.error,
});
