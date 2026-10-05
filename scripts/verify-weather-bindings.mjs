import { readFile } from 'node:fs/promises';

const EXPECTED = {
  development: { navlog: 'ppl-navlog-development', coordinator: 'ppl-navlog-weather-development' },
  production: { navlog: 'ppl-navlog-production', coordinator: 'ppl-navlog-weather-production' },
};

function environment(config, name, role) {
  const env = config?.env?.[name];
  if (!env) throw new Error(`${role} configuration is missing the ${name} environment.`);
  return env;
}

export function verifyWeatherBindings(navlogConfig, coordinatorConfig) {
  const coordinatorNames = new Set();
  const limiterNamespaceIds = new Set();
  if (hasPublicRoute(coordinatorConfig)) throw new Error('Weather coordinator must not define a public route.');
  if (coordinatorConfig.workers_dev !== false || coordinatorConfig.preview_urls !== false) {
    throw new Error('Weather coordinator base config must disable workers.dev and preview URLs.');
  }
  for (const [envName, expected] of Object.entries(EXPECTED)) {
    const app = environment(navlogConfig, envName, 'Navlog');
    const coordinator = environment(coordinatorConfig, envName, 'Weather coordinator');
    if (app.name !== expected.navlog || coordinator.name !== expected.coordinator) {
      throw new Error(`${envName} target mismatch: expected ${expected.navlog} and ${expected.coordinator}.`);
    }
    if (coordinatorNames.has(coordinator.name)) throw new Error('Development and production coordinator targets must be isolated.');
    coordinatorNames.add(coordinator.name);
    if (hasPublicRoute(coordinator)) {
      throw new Error(`${envName} coordinator must have no public route, workers.dev, or preview URL.`);
    }
    if (coordinator.workers_dev !== false || coordinator.preview_urls !== false) {
      throw new Error(`${envName} coordinator must disable workers.dev and preview URLs.`);
    }
    if (app.workers_dev !== false) throw new Error(`${envName} navlog must disable workers.dev.`);
    const services = app.services ?? [];
    if (!services.some((binding) => binding.binding === 'RUNWAY_PICKER_API' && binding.service === 'runway-picker-metar-api')) {
      throw new Error(`${envName} must preserve RUNWAY_PICKER_API -> runway-picker-metar-api.`);
    }
    const coordinatorBinding = services.filter((binding) => binding.binding === 'AWC_COORDINATOR_API');
    if (coordinatorBinding.length !== 1 || coordinatorBinding[0].service !== coordinator.name) {
      throw new Error(`${envName} AWC_COORDINATOR_API targets ${coordinatorBinding[0]?.service ?? 'no worker'}; expected ${coordinator.name} for ${envName}.`);
    }
    const limits = app.ratelimits ?? [];
    const rateLimiters = limits.filter((binding) => binding.name === 'API_RATE_LIMITER');
    if (rateLimiters.length !== 1) throw new Error(`${envName} requires exactly one API_RATE_LIMITER.`);
    if (limiterNamespaceIds.has(String(rateLimiters[0].namespace_id))) throw new Error('Development and production must use distinct API_RATE_LIMITER namespaces.');
    limiterNamespaceIds.add(String(rateLimiters[0].namespace_id));
    const objects = coordinator.durable_objects?.bindings ?? [];
    const weatherBudget = objects.filter((binding) => binding.name === 'WEATHER_BUDGET');
    if (weatherBudget.length !== 1 || weatherBudget[0].class_name !== 'WeatherBudgetCoordinator' ||
        weatherBudget[0].script_name != null || weatherBudget[0].environment != null) {
      throw new Error(`${envName} requires exactly one local WEATHER_BUDGET binding to WeatherBudgetCoordinator.`);
    }
    const migration = (coordinator.migrations ?? []).flatMap((item) => item.new_sqlite_classes ?? []);
    if (!migration.includes('WeatherBudgetCoordinator')) throw new Error(`${envName} requires its own SQLite class migration.`);
  }
  return true;
}

function hasPublicRoute(config) {
  return hasRouteValue(config?.route) || hasRouteValue(config?.routes);
}

function hasRouteValue(route) {
  if (route == null) return false;
  if (typeof route === 'string') return route.trim().length > 0;
  if (Array.isArray(route)) return route.length > 0;
  if (typeof route === 'object') return Object.keys(route).length > 0;
  return Boolean(route);
}

if (process.argv[1]?.endsWith('/verify-weather-bindings.mjs')) {
  const [navlogPath, coordinatorPath] = process.argv.slice(2);
  if (!navlogPath || !coordinatorPath) throw new Error('Usage: verify-weather-bindings.mjs <navlog-config> <coordinator-config>');
  const navlog = JSON.parse(await readFile(navlogPath, 'utf8'));
  const coordinator = JSON.parse(await readFile(coordinatorPath, 'utf8'));
  verifyWeatherBindings(navlog, coordinator);
  console.log('Development and production weather bindings are isolated and private.');
}
