import { describe, expect, it, vi } from "vitest";
import { MAX_RECOVERY_ARCHIVE_BYTES } from "../services/storage/json-transfer";
import { renderPlanPortability } from "./plan-portability";

describe("plan portability", () => {
  it("does not read oversized recovery snapshots", () => {
    const importPlanRecoveryArchive = vi.fn();
    const report = vi.fn();
    const panel = renderPlanPortability({ exportPlanRecoveryArchive: vi.fn(), importPlanRecoveryArchive }, "plan-1", report, vi.fn());
    const input = panel.querySelector("input")!;
    const file = new File(["x".repeat(MAX_RECOVERY_ARCHIVE_BYTES + 1)], "archive.json", { type: "application/json" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change"));
    expect(importPlanRecoveryArchive).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(expect.stringContaining("nothing was written"));
  });

  it("exports the active plan and restores an independent recovery copy", async () => {
    const exportPlanRecoveryArchive = vi.fn().mockResolvedValue("archive");
    const importPlanRecoveryArchive = vi.fn().mockResolvedValue({ planFamilies: 1, planRevisions: 1, aircraftProfiles: 1, weatherSnapshots: 0, recoveredPlanId: "new-plan" });
    const refreshed = vi.fn().mockResolvedValue(undefined);
    const report = vi.fn();
    const panel = renderPlanPortability({ exportPlanRecoveryArchive, importPlanRecoveryArchive }, "plan-1", report, refreshed);
    const input = panel.querySelector("input")!;
    Object.defineProperty(input, "files", { configurable: true, value: [{ size: 12, text: async () => "validated elsewhere" }] });
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(refreshed).toHaveBeenCalledOnce());
    expect(importPlanRecoveryArchive).toHaveBeenCalledWith("validated elsewhere");
    expect(report).toHaveBeenCalledWith(expect.stringContaining("Choose current weather and recalculate"));
    expect(panel.textContent).toContain("Download current plan recovery snapshot");
  });

  it("does not offer a recovery download until a saved plan is open", () => {
    const panel = renderPlanPortability({ exportPlanRecoveryArchive: vi.fn(), importPlanRecoveryArchive: vi.fn() }, undefined, vi.fn(), vi.fn());
    expect(panel.textContent).toContain("Open a saved plan");
  });
});
