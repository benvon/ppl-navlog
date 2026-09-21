import { describe, expect, it, vi } from "vitest";
import { MAX_IMPORT_BYTES } from "../services/storage/json-transfer";
import { renderPlanPortability } from "./plan-portability";

describe("plan portability", () => {
  it("rejects oversize files before reading or writing", async () => {
    const importJson = vi.fn();
    const report = vi.fn();
    const panel = renderPlanPortability({ exportJson: vi.fn(), importJson }, report, vi.fn());
    const input = panel.querySelector("input")!;
    const file = new File(["x".repeat(MAX_IMPORT_BYTES + 1)], "backup.json", { type: "application/json" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change"));
    expect(importJson).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(expect.stringContaining("nothing was written"));
  });

  it("imports only in merge mode and refreshes local state", async () => {
    const importJson = vi.fn().mockResolvedValue({ planFamilies: 1, planRevisions: 2, aircraftProfiles: 1, weatherSnapshots: 1 });
    const refreshed = vi.fn().mockResolvedValue(undefined);
    const report = vi.fn();
    const panel = renderPlanPortability({ exportJson: vi.fn(), importJson }, report, refreshed);
    const input = panel.querySelector("input")!;
    Object.defineProperty(input, "files", { configurable: true, value: [{ size: 12, text: async () => "validated elsewhere" }] });
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(refreshed).toHaveBeenCalledOnce());
    expect(importJson).toHaveBeenCalledWith("validated elsewhere", "merge");
    expect(report).toHaveBeenCalledWith(expect.stringContaining("Imported 1 plans"));
  });
});
