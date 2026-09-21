import { createLocalStudyAirportLookup } from './application/airport-lookup';
import { createBrowserUseCaseIds, createSystemClock } from './application/plan-use-cases';
import { IndexedDbNavlogRepository } from './services/storage/indexed-db-repository';
import { renderApp } from './ui/renderApp';
import './ui/styles.css';

const root = document.querySelector<HTMLElement>('#app');

if (!root) {
  throw new Error('Application root was not found.');
}

renderApp(root, {
  version: import.meta.env.VITE_APP_VERSION ?? 'v0.0.0-dev',
  commitSha: import.meta.env.VITE_APP_COMMIT_SHA ?? 'local'
}, {
  airportLookup: createLocalStudyAirportLookup(),
  persistence: new IndexedDbNavlogRepository(),
  ids: createBrowserUseCaseIds(),
  clock: createSystemClock()
});
