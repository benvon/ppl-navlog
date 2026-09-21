import { renderPlanner, type PlannerDependencies } from "./planner";

export interface BuildIdentity {
  version: string;
  commitSha: string;
}

export function renderApp(root: HTMLElement, build: BuildIdentity, plannerDependencies?: PlannerDependencies): void {
  const main = document.createElement('main');
  const heading = document.createElement('h1');
  const description = document.createElement('p');
  const status = document.createElement('p');

  main.className = 'app-shell';
  heading.textContent = 'PPL Navlog';
  description.textContent = 'A VFR flight-planning log that will make every calculation visible.';
  status.className = 'build-identity';
  status.textContent = `Build ${build.version} (${build.commitSha})`;

  main.append(heading, description, status);
  if (plannerDependencies === undefined) {
    main.append(text("p", "The planning workspace is initializing."));
  } else {
    const workspace = document.createElement("div");
    workspace.className = "planning-workspace";
    main.append(workspace);
    renderPlanner(workspace, plannerDependencies);
  }
  root.replaceChildren(main);
}

function text(tag: "p", content: string): HTMLElement {
  const element = document.createElement(tag);
  element.textContent = content;
  return element;
}
