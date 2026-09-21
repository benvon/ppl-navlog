import { WorkerAirportLookup } from './services/airport/worker-airport-lookup';
import { WorkerWindsClient } from './services/weather/winds-client';
import { createBrowserPlanCalculator } from './application/browser-plan-calculator';
import { createBrowserWeatherRefresh } from './application/browser-weather-refresh';
import { createBrowserUseCaseIds, createSystemClock } from './application/plan-use-cases';
import { IndexedDbNavlogRepository } from './services/storage/indexed-db-repository';
import { renderApp } from './ui/renderApp';
import './ui/styles.css';

const root = document.querySelector<HTMLElement>('#app');

if (!root) {
  throw new Error('Application root was not found.');
}

const persistence = new IndexedDbNavlogRepository();
const winds = new WorkerWindsClient();
const ids = createBrowserUseCaseIds();
const clock = createSystemClock();

renderApp(root, {
  version: import.meta.env.VITE_APP_VERSION ?? 'v0.0.0-dev',
  commitSha: import.meta.env.VITE_APP_COMMIT_SHA ?? 'local'
}, {
  airportLookup: new WorkerAirportLookup(),
  winds,
  persistence,
  weatherEvidence: persistence,
  portability: persistence,
  ids,
  clock,
  calculatePlan: createBrowserPlanCalculator(persistence, winds, ids, clock),
  refreshWeather: createBrowserWeatherRefresh(persistence, winds, ids, clock)
});
