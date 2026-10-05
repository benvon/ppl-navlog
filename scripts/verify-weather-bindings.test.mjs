import { describe, expect, it } from 'vitest';
import { verifyWeatherBindings } from './verify-weather-bindings.mjs';

const config = () => {
  const navlog = { env: {} };
  const coordinator = { env: {} };
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
  it('rejects shared namespaces and public routes', () => {
    const shared = config();
    shared.coordinator.env.development.durable_objects.bindings[0].namespace_id = 'same';
    shared.coordinator.env.production.durable_objects.bindings[0].namespace_id = 'same';
    expect(() => verifyWeatherBindings(shared.navlog, shared.coordinator)).toThrow(/namespace/i);
    const routed = config();
    routed.coordinator.env.production.routes = [{ pattern: '*/*' }];
    expect(() => verifyWeatherBindings(routed.navlog, routed.coordinator)).toThrow(/public route/i);
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
