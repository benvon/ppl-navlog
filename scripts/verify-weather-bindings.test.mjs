import { describe, expect, it } from 'vitest';
import { verifyWeatherBindings } from './verify-weather-bindings.mjs';

const config = () => {
  const navlog = { env: {} };
  const coordinator = { workers_dev: false, preview_urls: false, env: {} };
  for (const env of ['development', 'production']) {
    const target = `ppl-navlog-weather-${env}`;
    navlog.env[env] = { name: `ppl-navlog-${env}`, workers_dev: false,
      services: [ { binding: 'RUNWAY_PICKER_API', service: 'runway-picker-metar-api' }, { binding: 'AWC_COORDINATOR_API', service: target } ],
      ratelimits: [{ name: 'API_RATE_LIMITER', namespace_id: env === 'development' ? '90221001' : '90221002' }] };
    coordinator.env[env] = { name: target, workers_dev: false, preview_urls: false,
      durable_objects: { bindings: [{ name: 'WEATHER_BUDGET', class_name: 'WeatherBudgetCoordinator' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['WeatherBudgetCoordinator'] }] };
  }
  return { navlog, coordinator };
};

describe('verifyWeatherBindings', () => {
  it('accepts isolated development and production targets', () => {
    expect(() => verifyWeatherBindings(...Object.values(config()))).not.toThrow();
  });
  it('rejects cross-environment bindings', () => {
    const { navlog, coordinator } = config();
    navlog.env.development.services.find((s) => s.binding === 'AWC_COORDINATOR_API').service = 'ppl-navlog-weather-production';
    expect(() => verifyWeatherBindings(navlog, coordinator)).toThrow(/development.*production/i);
  });
  it('rejects external Durable Object bindings and duplicate local class bindings', () => {
    const external = config();
    external.coordinator.env.development.durable_objects.bindings[0].script_name = 'ppl-navlog-weather-production';
    expect(() => verifyWeatherBindings(external.navlog, external.coordinator)).toThrow(/local WEATHER_BUDGET/i);
    const externalEnvironment = config();
    externalEnvironment.coordinator.env.development.durable_objects.bindings[0].environment = 'production';
    expect(() => verifyWeatherBindings(externalEnvironment.navlog, externalEnvironment.coordinator)).toThrow(/local WEATHER_BUDGET/i);
    const duplicate = config();
    duplicate.coordinator.env.development.durable_objects.bindings.push({ name: 'WEATHER_BUDGET', class_name: 'WeatherBudgetCoordinator' });
    expect(() => verifyWeatherBindings(duplicate.navlog, duplicate.coordinator)).toThrow(/exactly one local WEATHER_BUDGET/i);
  });
  it('rejects inherited and singular public routes', () => {
    const inherited = config();
    inherited.coordinator.routes = [{ pattern: 'weather.example.com/*' }];
    expect(() => verifyWeatherBindings(inherited.navlog, inherited.coordinator)).toThrow(/public route/i);
    const singular = config();
    singular.coordinator.env.production.route = 'weather.example.com/*';
    expect(() => verifyWeatherBindings(singular.navlog, singular.coordinator)).toThrow(/public route/i);
    const envPlural = config();
    envPlural.coordinator.env.production.routes = [{ pattern: 'weather.example.com/*' }];
    expect(() => verifyWeatherBindings(envPlural.navlog, envPlural.coordinator)).toThrow(/public route/i);
    const baseSingular = config();
    baseSingular.coordinator.route = 'weather.example.com/*';
    expect(() => verifyWeatherBindings(baseSingular.navlog, baseSingular.coordinator)).toThrow(/public route/i);
  });
  it('rejects shared rate-limit namespaces', () => {
    const sharedLimiter = config();
    sharedLimiter.navlog.env.production.ratelimits[0].namespace_id = sharedLimiter.navlog.env.development.ratelimits[0].namespace_id;
    expect(() => verifyWeatherBindings(sharedLimiter.navlog, sharedLimiter.coordinator)).toThrow(/API_RATE_LIMITER namespaces/i);
  });
  it('requires both limiter and coordinator controls', () => {
    const noLimiter = config();
    noLimiter.navlog.env.development.ratelimits = [];
    expect(() => verifyWeatherBindings(noLimiter.navlog, noLimiter.coordinator)).toThrow(/API_RATE_LIMITER/i);
    const noCoordinator = config();
    noCoordinator.navlog.env.development.services = noCoordinator.navlog.env.development.services.filter((s) => s.binding !== 'AWC_COORDINATOR_API');
    expect(() => verifyWeatherBindings(noCoordinator.navlog, noCoordinator.coordinator)).toThrow(/AWC_COORDINATOR_API/i);
  });
});
