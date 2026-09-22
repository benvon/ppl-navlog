import type { ImportResult } from "../services/storage/contracts";
import { MAX_ARCHIVE_BYTES } from "../services/storage/json-transfer";

export interface PlanPortabilityRepository {
  exportPlanArchive(planId: string): Promise<string>;
  exportProfileArchive(): Promise<string>;
  importArchive(serialized: string, mode: "merge"): Promise<ImportResult>;
}

/** Browser-local bounded archives; no plan data leaves the device. */
export function renderPlanPortability(repository: PlanPortabilityRepository, activePlanId: string | undefined, report: (message: string) => void, onImported: () => Promise<void>): HTMLElement {
  const section = document.createElement("section");
  section.className = "plan-portability";
  const heading = document.createElement("h3");
  heading.textContent = "Local plan archives";
  const explanation = document.createElement("p");
  explanation.textContent = "Download the open plan's retained journal, aircraft data, and weather evidence as one restorable JSON archive. Profiles can be archived separately. Import merges one archive at a time; conflicts write nothing. This does not upload data.";
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
  if (activePlanId !== undefined) archiveButtons.push(download("Download open plan archive", "ppl-navlog-plan", () => repository.exportPlanArchive(activePlanId)));
  else archiveButtons.push(Object.assign(document.createElement("p"), { textContent: "Open a saved plan to download its archive." }));
  archiveButtons.push(download("Download aircraft profiles archive", "ppl-navlog-profiles", () => repository.exportProfileArchive()));
  const label = document.createElement("label");
  label.textContent = "Import a navlog plan or profiles archive";
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (file === undefined) return;
    if (file.size > MAX_ARCHIVE_BYTES) {
      report(`Import exceeds the ${MAX_ARCHIVE_BYTES} byte archive limit; nothing was written.`);
      input.value = "";
      return;
    }
    try {
      const result = await repository.importArchive(await file.text(), "merge");
      await onImported();
      report(`Imported ${result.planFamilies} plans, ${result.planRevisions} revisions, ${result.aircraftProfiles} aircraft profiles, and ${result.weatherSnapshots} weather snapshots.`);
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
