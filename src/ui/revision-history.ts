import type { PlanRevision } from "../domain/route";

export interface RevisionHistoryOptions {
  readonly revisions: readonly PlanRevision[];
  readonly selectedRevisionId?: string;
  readonly onSelect: (revisionId: string) => void;
}

/** Displays immutable saved revisions; selection is explicit and never mutates a revision. */
export function renderRevisionHistory(options: RevisionHistoryOptions): HTMLElement {
  const section = document.createElement("section");
  section.className = "revision-history";
  const heading = document.createElement("h3");
  heading.textContent = "Saved revision history";
  section.append(heading);
  const retention = document.createElement("p");
  retention.textContent = "The latest 20 immutable revisions are retained for each plan; saving a newer revision removes the oldest.";
  section.append(retention);
  if (options.revisions.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "No saved revisions for this plan yet.";
    section.append(empty);
    return section;
  }
  const list = document.createElement("ol");
  const ordered = [...options.revisions].sort((a, b) => b.revisionNumber - a.revisionNumber);
  for (const revision of ordered) {
    const item = document.createElement("li");
    const selected = revision.id === options.selectedRevisionId;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `Revision ${revision.revisionNumber} · ${revision.createdAt} · ${revision.reason}${selected ? " (open)" : ""}`;
    button.setAttribute("aria-current", selected ? "true" : "false");
    button.addEventListener("click", () => options.onSelect(revision.id));
    item.append(button);
    if (revision.parentRevisionId !== undefined) {
      const lineage = document.createElement("span");
      lineage.textContent = ` Previous journal entry: ${revision.parentRevisionId}`;
      item.append(lineage);
    }
    list.append(item);
  }
  section.append(list);
  const selected = ordered.find((revision) => revision.id === options.selectedRevisionId);
  const parent = selected === undefined ? undefined : ordered.find((revision) => revision.id === selected.parentRevisionId);
  if (selected !== undefined && parent !== undefined) section.append(renderRevisionComparison(parent, selected));
  return section;
}

/** A compact, source-aware comparison; detailed calculation evidence remains in each revision. */
export function renderRevisionComparison(previous: PlanRevision, current: PlanRevision): HTMLElement {
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = `Compare open revision with parent ${previous.id}`;
  details.append(summary);
  const changes = [
    comparison("Departure time", previous.draftSnapshot.departureTimeUtc, current.draftSnapshot.departureTimeUtc),
    comparison("Forecast valid time", previous.draftSnapshot.weatherSelection?.forecastValidTimeUtc, current.draftSnapshot.weatherSelection?.forecastValidTimeUtc),
    comparison("Aircraft profile", previous.aircraftProfileSnapshot.profile.name, current.aircraftProfileSnapshot.profile.name),
    comparison("Route points", previous.draftSnapshot.route.points.map((point) => point.name).join(" → "), current.draftSnapshot.route.points.map((point) => point.name).join(" → ")),
    comparison("Weather evidence IDs", previous.weatherSnapshotIds.join(", "), current.weatherSnapshotIds.join(", ")),
    comparison("Calculation status", calculationStatus(previous), calculationStatus(current)),
  ].filter((change): change is string => change !== undefined);
  const paragraph = document.createElement("p");
  paragraph.textContent = changes.length === 0 ? "No differences in the compared summary fields. Inspect each revision for full calculation details." : changes.join(" | ");
  details.append(paragraph);
  return details;
}

function comparison(label: string, previous: string | undefined, current: string | undefined): string | undefined {
  return previous === current ? undefined : `${label}: ${previous || "none"} → ${current || "none"}`;
}

function calculationStatus(revision: PlanRevision): string {
  const snapshot = revision.calculationSnapshot;
  return typeof snapshot === "object" && snapshot !== null && !Array.isArray(snapshot) && "status" in snapshot && typeof snapshot.status === "string"
    ? snapshot.status : "unavailable";
}
