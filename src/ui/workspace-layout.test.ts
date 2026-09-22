import { describe, expect, it } from "vitest";
import { renderWorkspaceLayout } from "./workspace-layout";

describe("workspace layout composition", () => {
  it("exposes semantic slots without encoding visual grid positions", () => {
    const regions = {
      aircraft: document.createElement("section"),
      route: document.createElement("section"),
      navlog: document.createElement("section"),
      inspector: document.createElement("section"),
    };
    const layout = renderWorkspaceLayout(regions);
    expect([...layout.children].map((element) => (element as HTMLElement).dataset.region)).toEqual(["aircraft", "route", "navlog", "inspector"]);
    expect(layout.querySelector('[data-region="navlog"]')).toBe(regions.navlog);
    expect(layout.querySelectorAll("[style]")).toHaveLength(0);
  });
});
