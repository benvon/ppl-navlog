import { WorkerAirportLookup } from './services/airport/worker-airport-lookup';
import { WorkerWindsClient } from './services/weather/winds-client';
import { createBrowserUseCaseIds, createSystemClock } from './application/plan-use-cases';
import { IndexedDbPilotInputRepository } from './services/storage/pilot-input-repository';
import { renderPilotIntentPlanner } from './ui/pilot-intent-planner';
import './ui/styles.css';

const root = document.querySelector<HTMLElement>('#app');

if (!root) {
  throw new Error('Application root was not found.');
}

const repository = new IndexedDbPilotInputRepository();
const winds = new WorkerWindsClient();
const ids = createBrowserUseCaseIds();
const clock = createSystemClock();

const main = document.createElement('main');
main.className = 'app-shell';
const heading = document.createElement('h1'); heading.textContent = 'PPL Navlog';
const description = document.createElement('p'); description.textContent = 'A VFR flight-planning log with inspectable calculations.';
const identity = document.createElement('p'); identity.className = 'build-identity'; identity.textContent = `Build ${import.meta.env.VITE_APP_VERSION ?? 'v0.0.0-dev'} (${import.meta.env.VITE_APP_COMMIT_SHA ?? 'local'})`;
const workspace = document.createElement('div'); workspace.className = 'planning-workspace';
main.append(heading, description, identity, workspace); root.replaceChildren(main);
renderPilotIntentPlanner(workspace, { repository, airportLookup: new WorkerAirportLookup(), winds, ids, clock });
