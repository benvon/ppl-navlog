import type { ImportResult } from "../services/storage/contracts";
import { MAX_IMPORT_BYTES } from "../services/storage/json-transfer";

export interface PlanPortabilityRepository {
  exportJson(): Promise<string>;
  importJson(serialized: string, mode: "merge"): Promise<ImportResult>;
}

/** Browser-local export and non-destructive merge import; no plan data leaves the device. */
export function renderPlanPortability(repository: PlanPortabilityRepository, report: (message: string) => void, onImported: () => Promise<void>): HTMLElement {
  const section = document.createElement("section");
  section.className = "plan-portability";
  const heading = document.createElement("h3");
  heading.textContent = "Local backup and import";
  const explanation = document.createElement("p");
  explanation.textContent = "Download a JSON backup of all local aircraft profiles, plans, revisions, and weather evidence. Import merges new records only; conflicts write nothing. This does not upload data.";
  const exportButton = document.createElement("button");
  exportButton.type = "button";
  exportButton.textContent = "Download local backup";
  exportButton.addEventListener("click", async () => {
    try {
      const contents = await repository.exportJson();
      const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `ppl-navlog-backup-${new Date().toISOString().slice(0, 10)}.json`;
        anchor.click();
        report("Local backup downloaded.");
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      report(error instanceof Error ? error.message : "The backup could not be downloaded.");
    }
  });
  const label = document.createElement("label");
  label.textContent = "Import a navlog JSON backup";
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (file === undefined) return;
    if (file.size > MAX_IMPORT_BYTES) {
      report(`Import exceeds the ${MAX_IMPORT_BYTES} byte limit; nothing was written.`);
      input.value = "";
      return;
    }
    try {
      const result = await repository.importJson(await file.text(), "merge");
      await onImported();
      report(`Imported ${result.planFamilies} plans, ${result.planRevisions} revisions, ${result.aircraftProfiles} aircraft profiles, and ${result.weatherSnapshots} weather snapshots.`);
    } catch (error) {
      report(error instanceof Error ? error.message : "Import failed; no records were written.");
    } finally {
      input.value = "";
    }
  });
  label.append(input);
  section.append(heading, explanation, exportButton, label);
  return section;
}
