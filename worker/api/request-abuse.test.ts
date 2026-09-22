import { describe, expect, it } from "vitest";
import { parseApiRoute } from "./request";

describe("API route abuse bounds", () => {
  it("rejects a route query that exceeds the parse budget", () => {
    const route = `41.${"1".repeat(4_100)},-88`;
    const request = new Request(`https://navlog.invalid/api/weather/winds/stations?route=${route}`);
    expect(() => parseApiRoute(request)).toThrow("route query exceeds the supported length");
  });
});
