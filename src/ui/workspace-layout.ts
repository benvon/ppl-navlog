export interface WorkspaceRegions {
  readonly aircraft: HTMLElement;
  readonly route: HTMLElement;
  readonly navlog: HTMLElement;
  readonly inspector: HTMLElement;
}

/** Semantic composition only. Layout and visual treatment live entirely in CSS. */
export function renderWorkspaceLayout(regions: WorkspaceRegions): HTMLElement {
  const layout = document.createElement("div");
  layout.className = "planner-layout";
  for (const name of ["aircraft", "route", "navlog", "inspector"] as const) {
    const region = regions[name];
    region.dataset.region = name;
    layout.append(region);
  }
  return layout;
}
