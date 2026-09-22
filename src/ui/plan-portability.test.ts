import { describe, expect, it, vi } from "vitest";
import { MAX_ARCHIVE_BYTES } from "../services/storage/json-transfer";
import { renderPlanPortability } from "./plan-portability";

describe("plan portability", () => {
  it("does not read oversized archives", () => {
    const importArchive = vi.fn();
    const report = vi.fn();
    const panel = renderPlanPortability({ exportPlanArchive: vi.fn(), exportProfileArchive: vi.fn(), importArchive }, "plan-1", report, vi.fn());
    const input = panel.querySelector("input")!;
    const file = new File(["x".repeat(MAX_ARCHIVE_BYTES + 1)], "archive.json", { type: "application/json" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change"));
    expect(importArchive).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(expect.stringContaining("nothing was written"));
  });

  it("exports the active plan only and imports one archive in merge mode", async () => {
    const exportPlanArchive = vi.fn().mockResolvedValue("archive");
    const importArchive = vi.fn().mockResolvedValue({ planFamilies: 1, planRevisions: 2, aircraftProfiles: 1, weatherSnapshots: 1 });
    const refreshed = vi.fn().mockResolvedValue(undefined);
    const report = vi.fn();
    const panel = renderPlanPortability({ exportPlanArchive, exportProfileArchive: vi.fn(), importArchive }, "plan-1", report, refreshed);
    const input = panel.querySelector("input")!;
    Object.defineProperty(input, "files", { configurable: true, value: [{ size: 12, text: async () => "validated elsewhere" }] });
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(refreshed).toHaveBeenCalledOnce());
    expect(importArchive).toHaveBeenCalledWith("validated elsewhere", "merge");
    expect(report).toHaveBeenCalledWith(expect.stringContaining("Imported 1 plans"));
    expect(panel.textContent).toContain("Download open plan archive");
  });

  it("does not offer a plan download until a saved plan is open", () => {
    const panel = renderPlanPortability({ exportPlanArchive: vi.fn(), exportProfileArchive: vi.fn(), importArchive: vi.fn() }, undefined, vi.fn(), vi.fn());
    expect(panel.textContent).toContain("Open a saved plan");
  });
});
