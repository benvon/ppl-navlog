import { trace, type CalculationTrace } from "./calculation-trace";
import { failure, success, type DomainResult } from "./errors";

/** An available published winds forecast period; validity starts inclusive and ends exclusive. */
export interface AvailableForecastValidPeriod {
  /** Stable provider period identifier chosen explicitly by the pilot. */
  readonly id: string;
  readonly validFromUtc: string;
  readonly validToUtc: string;
}

export interface ForecastValidTimeSelection {
  readonly period: AvailableForecastValidPeriod;
  readonly departureTimeUtc: string;
  readonly selectionMethod: "explicit-period-id";
  readonly trace: CalculationTrace;
}

const utcInstantPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

const parseUtcInstant = (value: string, field: string): DomainResult<number> => {
  const matched = utcInstantPattern.exec(value);
  if (matched === null) {
    return failure("INVALID_FORECAST_PERIOD", `${field} must be an ISO-8601 UTC instant.`, { field, value });
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    return failure("INVALID_FORECAST_PERIOD", `${field} must be an ISO-8601 UTC instant.`, { field, value });
  }
  const parsedDate = new Date(milliseconds);
  const expectedComponents = matched.slice(1, 7);
  const actualComponents = [
    String(parsedDate.getUTCFullYear()).padStart(4, "0"),
    String(parsedDate.getUTCMonth() + 1).padStart(2, "0"),
    String(parsedDate.getUTCDate()).padStart(2, "0"),
    String(parsedDate.getUTCHours()).padStart(2, "0"),
    String(parsedDate.getUTCMinutes()).padStart(2, "0"),
    String(parsedDate.getUTCSeconds()).padStart(2, "0"),
  ];
  if (expectedComponents.some((component, index) => component !== actualComponents[index])) {
    return failure("INVALID_FORECAST_PERIOD", `${field} must be a real ISO-8601 UTC instant.`, { field, value });
  }
  return success(milliseconds);
};

const validPeriod = (period: AvailableForecastValidPeriod): DomainResult<{ readonly from: number; readonly to: number }> => {
  if (period.id.trim().length === 0) {
    return failure("INVALID_FORECAST_PERIOD", "Forecast period identifier must not be empty.", { periodId: period.id });
  }
  const from = parseUtcInstant(period.validFromUtc, "Forecast valid-from time");
  if (!from.ok) return from;
  const to = parseUtcInstant(period.validToUtc, "Forecast valid-to time");
  if (!to.ok) return to;
  if (to.value <= from.value) {
    return failure("INVALID_FORECAST_PERIOD", "Forecast valid-to time must be after valid-from time.", {
      periodId: period.id,
      validFromUtc: period.validFromUtc,
      validToUtc: period.validToUtc,
    });
  }
  return success({ from: from.value, to: to.value });
};

/**
 * Validates an explicit pilot-selected forecast period. It never selects a
 * nearby period or substitutes one when departure lies outside the selection.
 */
export const selectForecastValidTime = (
  periods: readonly AvailableForecastValidPeriod[],
  selectedPeriodId: string,
  departureTimeUtc: string,
): DomainResult<ForecastValidTimeSelection> => {
  const departure = parseUtcInstant(departureTimeUtc, "Departure time");
  if (!departure.ok) return departure;
  if (selectedPeriodId.trim().length === 0) {
    return failure("INVALID_FORECAST_PERIOD", "A forecast valid period must be selected explicitly.", {
      selectedPeriodId,
    });
  }
  const matchingPeriods = periods.filter((period) => period.id === selectedPeriodId);
  if (matchingPeriods.length !== 1) {
    return failure("INVALID_FORECAST_PERIOD", "Selected forecast valid period is unavailable or ambiguous.", {
      selectedPeriodId,
      availablePeriodIds: periods.map((period) => period.id).join(","),
    });
  }
  const selectedPeriod = matchingPeriods[0];
  if (selectedPeriod === undefined) {
    return failure("INVALID_FORECAST_PERIOD", "Selected forecast valid period is unavailable or ambiguous.", {
      selectedPeriodId,
    });
  }
  const validity = validPeriod(selectedPeriod);
  if (!validity.ok) return validity;
  if (departure.value < validity.value.from || departure.value >= validity.value.to) {
    return failure("FORECAST_OUTSIDE_VALIDITY", "Departure time is outside the explicitly selected forecast valid period.", {
      departureTimeUtc,
      selectedPeriodId,
      validFromUtc: selectedPeriod.validFromUtc,
      validToUtc: selectedPeriod.validToUtc,
    });
  }
  return success({
    period: selectedPeriod,
    departureTimeUtc,
    selectionMethod: "explicit-period-id",
    trace: trace(
      "explicit-forecast-valid-time-selection",
      [
        { name: "departure time UTC", value: departureTimeUtc, unit: "unitless" },
        { name: "selected period", value: selectedPeriod.id, unit: "unitless" },
      ],
      [
        { name: "valid from UTC", value: selectedPeriod.validFromUtc, unit: "unitless" },
        { name: "valid to UTC", value: selectedPeriod.validToUtc, unit: "unitless" },
      ],
      { name: "selected forecast period", value: selectedPeriod.id, unit: "unitless" },
    ),
  });
};
