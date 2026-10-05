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
  const namespaceIds = new Set();
  const limiterNamespaceIds = new Set();
  for (const [envName, expected] of Object.entries(EXPECTED)) {
    const app = environment(navlogConfig, envName, 'Navlog');
    const coordinator = environment(coordinatorConfig, envName, 'Weather coordinator');
    if (app.name !== expected.navlog || coordinator.name !== expected.coordinator) {
      throw new Error(`${envName} target mismatch: expected ${expected.navlog} and ${expected.coordinator}.`);
    }
    if (coordinatorNames.has(coordinator.name)) throw new Error('Development and production coordinator targets must be isolated.');
    coordinatorNames.add(coordinator.name);
    if (coordinator.routes?.length || coordinator.workers_dev !== false || coordinator.preview_urls !== false) {
      throw new Error(`${envName} coordinator must have no public route, workers.dev, or preview URL.`);
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
    if (!objects.some((binding) => binding.name === 'WEATHER_BUDGET' && binding.class_name === 'WeatherBudgetCoordinator')) {
      throw new Error(`${envName} requires the WEATHER_BUDGET control.`);
    }
    const migration = (coordinator.migrations ?? []).flatMap((item) => item.new_sqlite_classes ?? []);
    if (!migration.includes('WeatherBudgetCoordinator')) throw new Error(`${envName} requires its own SQLite class migration.`);
    for (const binding of objects) {
      if (binding.namespace_id != null) {
        if (namespaceIds.has(String(binding.namespace_id))) throw new Error('Development and production must use distinct Durable Object namespaces.');
        namespaceIds.add(String(binding.namespace_id));
      }
    }
  }
  return true;
}

if (process.argv[1]?.endsWith('/verify-weather-bindings.mjs')) {
  const [navlogPath, coordinatorPath] = process.argv.slice(2);
  if (!navlogPath || !coordinatorPath) throw new Error('Usage: verify-weather-bindings.mjs <navlog-config> <coordinator-config>');
  const navlog = JSON.parse(await readFile(navlogPath, 'utf8'));
  const coordinator = JSON.parse(await readFile(coordinatorPath, 'utf8'));
  verifyWeatherBindings(navlog, coordinator);
  console.log('Development and production weather bindings are isolated and private.');
}
