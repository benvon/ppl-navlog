import { renderPlanner, type PlannerDependencies } from "./planner";

export interface BuildIdentity {
  version: string;
  commitSha: string;
}

export function renderApp(root: HTMLElement, build: BuildIdentity, plannerDependencies?: PlannerDependencies): void {
  const main = document.createElement('main');
  const heading = document.createElement('h1');
  const description = document.createElement('p');
  const disclaimer = document.createElement('p');
  const footer = document.createElement('footer');
  const status = document.createElement('p');

  main.className = 'app-shell';
  heading.textContent = 'PPL Navlog';
  description.textContent = 'A VFR navigation planning study tool with inspectable calculations.';
  disclaimer.className = 'teaching-disclaimer';
  disclaimer.textContent = 'For teaching purposes only. Not for actual flight planning or a complete preflight briefing.';
  status.className = 'build-identity';
  status.textContent = `Build ${build.version} (${build.commitSha})`;
  footer.append(status);

  main.append(heading, description, disclaimer);
  if (plannerDependencies === undefined) {
    main.append(text("p", "The planning workspace is initializing."));
  } else {
    const workspace = document.createElement("div");
    workspace.className = "planning-workspace";
    main.append(workspace);
    renderPlanner(workspace, plannerDependencies);
  }
  main.append(footer);
  root.replaceChildren(main);
}

function text(tag: "p", content: string): HTMLElement {
  const element = document.createElement(tag);
  element.textContent = content;
  return element;
}
