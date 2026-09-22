import type { ImportResult } from "../services/storage/contracts";
import { MAX_RECOVERY_ARCHIVE_BYTES } from "../services/storage/json-transfer";

export interface PlanPortabilityRepository {
  exportPlanRecoveryArchive(planId: string): Promise<string>;
  importPlanRecoveryArchive(serialized: string): Promise<ImportResult>;
}

/** Browser-local recovery snapshots; no plan data leaves the device. */
export function renderPlanPortability(repository: PlanPortabilityRepository, activePlanId: string | undefined, report: (message: string) => void, onImported: () => Promise<void>): HTMLElement {
  const section = document.createElement("section");
  section.className = "plan-portability";
  const heading = document.createElement("h3");
  heading.textContent = "Plan recovery snapshot";
  const explanation = document.createElement("p");
  explanation.textContent = "Download the current route and aircraft profile as a small local JSON recovery snapshot. It excludes revision history, calculated results, and weather evidence. Import creates a new local plan with fresh IDs; choose current weather and recalculate before use. This does not upload data.";
  const download = (label: string, filename: string, exportArchive: () => Promise<string>): HTMLButtonElement => {
    const exportButton = document.createElement("button");
    exportButton.type = "button";
    exportButton.textContent = label;
    exportButton.addEventListener("click", async () => {
      try {
        const contents = await exportArchive();
        const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
        try {
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = `${filename}-${new Date().toISOString().slice(0, 10)}.json`;
          anchor.click();
          report(`${label} downloaded.`);
        } finally {
          URL.revokeObjectURL(url);
        }
      } catch (error) {
        report(error instanceof Error ? error.message : "The archive could not be downloaded.");
      }
    });
    return exportButton;
  };
  const archiveButtons: HTMLElement[] = [];
  if (activePlanId !== undefined) archiveButtons.push(download("Download current plan recovery snapshot", "ppl-navlog-recovery", () => repository.exportPlanRecoveryArchive(activePlanId)));
  else archiveButtons.push(Object.assign(document.createElement("p"), { textContent: "Open a saved plan to download its recovery snapshot." }));
  const label = document.createElement("label");
  label.textContent = "Recover a plan from JSON";
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (file === undefined) return;
    if (file.size > MAX_RECOVERY_ARCHIVE_BYTES) {
      report(`Import exceeds the ${MAX_RECOVERY_ARCHIVE_BYTES} byte recovery archive limit; nothing was written.`);
      input.value = "";
      return;
    }
    try {
      await repository.importPlanRecoveryArchive(await file.text());
      await onImported();
      report(`Recovered a new plan with one aircraft profile. Choose current weather and recalculate before use.`);
    } catch (error) {
      report(error instanceof Error ? error.message : "Import failed; no records were written.");
    } finally {
      input.value = "";
    }
  });
  label.append(input);
  section.append(heading, explanation, ...archiveButtons, label);
  return section;
}
