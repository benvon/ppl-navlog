#!/usr/bin/env node

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = 'a616ec5ad4e3a386106c4e6d7c50f4581bcc797d';
const FIXED_NOW = '2026-10-06T12:00:00.000Z';
const ITERATIONS = 3;
const ROUTE_SIZES = [5, 28];
const NativeDate = globalThis.Date;

function assert(condition, message) { if (!condition) throw new Error(message); }
const bytes = (value) => Buffer.byteLength(value, 'utf8');
const stationId = (i) => i === 0 ? 'AAA' : i.toString(36).toUpperCase().padStart(3, '0').slice(-3);

function makeCatalog(count) {
  return {
    kind: 'catalog', key: 'station-catalog:v1',
    metadata: {
      fetchedAt: '2026-10-05T12:00:00.000Z', checkedAt: '2026-10-06T11:55:00.000Z',
      refreshAfter: '2026-10-07T11:55:00.000Z', staleUntil: '2026-10-07T11:57:00.000Z'
    },
    entries: Array.from({ length: count }, (_, i) => ({
      iataId: stationId(i),
      info: {
        name: i === 0 ? 'Benchmark station' : `Synthetic winds station ${i}`,
        coordinates: i === 0 ? { latitudeDeg: 41, longitudeDeg: -90 } : {
          latitudeDeg: 25 + ((i * 37) % 250) / 10,
          longitudeDeg: -125 + ((i * 61) % 600) / 10
        },
        elevationFt: 800
      }
    }))
  };
}

function makeProduct(cycle) {
  const issue = '2026-10-06T06:00:00.000Z';
  const periods = {
    '06': ['2026-10-06T05:00:00.000Z', '2026-10-06T11:00:00.000Z'],
    '12': ['2026-10-06T11:00:00.000Z', '2026-10-06T17:00:00.000Z'],
    '24': ['2026-10-06T17:00:00.000Z', '2026-10-06T23:00:00.000Z']
  };
  const [useFrom, useUntil] = periods[cycle];
  return {
    kind: 'winds', key: `winds:us:${cycle}`,
    metadata: {
      fetchedAt: '2026-10-06T06:00:00.000Z', checkedAt: '2026-10-06T11:55:00.000Z',
      refreshAfter: '2026-10-06T12:55:00.000Z', staleUntil: '2026-10-06T12:57:00.000Z'
    },
    rawProduct: `SYNTHETIC OPAQUE CACHE FIXTURE ${cycle} `.padEnd(12_000, 'x'),
    forecasts: Array.from({ length: 120 }, (_, i) => ({
      stationId: stationId(i), forecastCycle: cycle, issuedAt: issue,
      validAt: FIXED_NOW, useFrom, useUntil,
      levels: Array.from({ length: 9 }, (_, levelIndex) => ({
        altitudeFt: (levelIndex + 1) * 3_000,
        windFromDegTrue: (220 + i + levelIndex * 10) % 360,
        windSpeedKt: 8 + (i % 20) + levelIndex,
        temperatureC: 12 - levelIndex * 3,
        availability: 'available',
        raw: `${String(2200 + i % 100).padStart(4, '0')}${String(12 + levelIndex).padStart(2, '0')}`
      }))
    }))
  };
}

function createFixtureCache(catalogCount, environment = 'production') {
  const resources = [makeCatalog(catalogCount), ...['06', '12', '24'].map(makeProduct)];
  const root = 'https://ppl-navlog-cache.invalid/weather-resource/v1';
  const serialized = new Map(resources.map((resource) => [
    `${root}/${environment}/${resource.kind === 'catalog' ? 'station-catalog/v1' : `winds/${resource.key.slice('winds:'.length)}`}`,
    JSON.stringify(resource)
  ]));
  const metrics = { matchCalls: 0, parsedBytes: 0, byKey: {}, perFetch: [], puts: 0, requestedUrls: [] };
  const cache = {
    async match(request) {
      metrics.matchCalls += 1;
      metrics.requestedUrls.push(request.url);
      const text = serialized.get(request.url);
      if (text === undefined) return undefined;
      metrics.parsedBytes += bytes(text);
      const key = request.url.split('/').slice(-2).join('/');
      metrics.byKey[key] = (metrics.byKey[key] ?? 0) + 1;
      return new Response(text, { headers: { 'Content-Type': 'application/json' } });
    },
    async put(request, response) {
      metrics.puts += 1;
      serialized.set(request.url, await response.text());
    }
  };
  return { cache, metrics, serialized };
}

function makeRequests(pointCount) {
  return Array.from({ length: pointCount }, (_, index) => {
    const step = pointCount === 1 ? 0 : (index / (pointCount - 1)) * 1.2 - 0.6;
    const query = new URLSearchParams({
      lat: (41 + step).toFixed(4), lon: (-90 + step).toFixed(4),
      altitudeFeetMsl: '6000', plannedUtc: FIXED_NOW
    });
    return new Request(`https://navlog.test/api/weather/winds/point?${query}`);
  });
}

function fixedClock() {
  const fixedMs = NativeDate.parse(FIXED_NOW);
  globalThis.Date = class FixedDate extends NativeDate {
    constructor(...args) { super(...(args.length === 0 ? [fixedMs] : args)); }
    static now() { return fixedMs; }
  };
}
function restoreClock() { globalThis.Date = NativeDate; }

async function compileAndLoad(label, sourceWorker, outputDir) {
  await mkdir(outputDir, { recursive: true });
  const program = ts.createProgram({
    rootNames: [path.join(sourceWorker, 'index.ts')],
    options: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
      types: [], rootDir: sourceWorker, outDir: outputDir,
      skipLibCheck: true, strict: true, esModuleInterop: true
    }
  });
  const emit = program.emit();
  const diagnostics = ts.getPreEmitDiagnostics(program).concat(emit.diagnostics);
  assert(!emit.emitSkipped && !diagnostics.some((d) => d.category === ts.DiagnosticCategory.Error),
    `${label} Worker compile failed: ${ts.formatDiagnostics(diagnostics, { getCurrentDirectory: () => ROOT, getCanonicalFileName: (x) => x, getNewLine: () => '\n' })}`);
  await writeFile(path.join(outputDir, 'package.json'), '{"type":"commonjs"}');
  const module = createRequire(import.meta.url)(path.join(outputDir, 'index.js'));
  assert(typeof module.default?.fetch === 'function', `${label} Worker entry point did not load`);
  return module;
}

function environment(cache, counters) {
  return {
    APP_ENV: 'production', WINDS_CACHE: cache,
    API_RATE_LIMITER: { async limit() { return { success: true }; } },
    AWC_COORDINATOR_API: { async fetch() { counters.coordinatorCalls += 1; throw new Error('Unexpected coordinator call.'); } },
    ASSETS: { async fetch() { return new Response('asset'); } }
  };
}

async function measure(workerModule, catalogCount, pointCount, requireStats) {
  const { cache, metrics, serialized } = createFixtureCache(catalogCount);
  const counters = { coordinatorCalls: 0, globalFetchCalls: 0 };
  const env = environment(cache, counters);
  const requests = makeRequests(pointCount);
  const pendingBackground = [];
  const context = { waitUntil(promise) { pendingBackground.push(promise); } };
  global.gc(); global.gc();
  const heapBefore = process.memoryUsage().heapUsed;
  const cpuBefore = process.cpuUsage();
  const wallBefore = process.hrtime.bigint();
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    for (const request of requests) {
      const callsBefore = metrics.matchCalls;
      const parsedBefore = metrics.parsedBytes;
      const response = await workerModule.default.fetch(request, env, context);
      if (response.status !== 200) throw new Error(`Worker response ${response.status}: ${await response.text()}`);
      const body = await response.json();
      assert(body.product?.cache?.servedAt === FIXED_NOW, 'Winds provenance did not use the fixed clock');
      assert(body.catalog?.cache?.servedAt === FIXED_NOW, 'Catalog provenance did not use the fixed clock');
      assert(body.query?.latitudeDeg !== undefined && body.sources?.length > 0, 'Worker did not return the expected point answer');
      metrics.perFetch.push({ reads: metrics.matchCalls - callsBefore, parsedBytes: metrics.parsedBytes - parsedBefore });
    }
  }
  await Promise.all(pendingBackground);
  const wallMs = Number(process.hrtime.bigint() - wallBefore) / 1e6;
  const cpu = process.cpuUsage(cpuBefore);
  global.gc(); global.gc();
  const heapAfter = process.memoryUsage().heapUsed;
  const firstSeries = metrics.perFetch.slice(0, pointCount);
  const warmSeries = metrics.perFetch.slice(pointCount, pointCount * 2);
  const expectedReads = requireStats ? 4 : ITERATIONS * pointCount * 4;
  assert(metrics.matchCalls === expectedReads, `Expected ${expectedReads} total edge-cache reads, got ${metrics.matchCalls}`);
  assert(metrics.perFetch[0]?.reads === 4, 'First Worker fetch did not read all three products and the station catalog');
  assert(metrics.perFetch.slice(1).every((item) => item.reads === (requireStats ? 0 : 4)), 'Warm Worker fetches did not follow the expected cache path');
  assert(metrics.perFetch[0]?.parsedBytes > 0 && (requireStats ? metrics.perFetch.slice(1).every((item) => item.parsedBytes === 0) : metrics.perFetch.slice(1).every((item) => item.parsedBytes > 0)), 'Parsed-byte counts do not match the expected cold/warm behavior');
  const statsFn = workerModule.getWeatherResourceCacheStatsForTesting;
  const stateSnapshot = typeof statsFn === 'function' ? statsFn('production', env.AWC_COORDINATOR_API, cache) : null;
  assert(!requireStats || stateSnapshot !== null, 'Current shared weather-cache stats export was not available');
  if (requireStats) {
    assert(stateSnapshot.entries === 4, `Expected four shared resources, got ${stateSnapshot.entries}`);
    assert(stateSnapshot.retainedBytes === [...serialized.values()].reduce((total, text) => total + bytes(text), 0), 'Shared retained-byte snapshot differs from fixture serialization size');
  }
  return {
    catalogEntries: catalogCount,
    pointCallsPerRouteSeries: pointCount,
    requestsTimed: ITERATIONS * pointCount,
    cacheReadsAcrossThreeSeries: metrics.matchCalls,
    parsedEdgeJsonBytesAcrossThreeSeries: metrics.parsedBytes,
    firstSeriesCacheReads: firstSeries.reduce((sum, item) => sum + item.reads, 0),
    nextSeriesCacheReads: warmSeries.reduce((sum, item) => sum + item.reads, 0),
    firstFetchReads: metrics.perFetch[0]?.reads ?? 0,
    secondFetchReads: metrics.perFetch[1]?.reads ?? 0,
    firstSeriesParsedEdgeJsonBytes: firstSeries.reduce((sum, item) => sum + item.parsedBytes, 0),
    cachePuts: metrics.puts,
    fixtureBytesByKey: Object.fromEntries([...serialized].map(([url, text]) => [url.split('/').slice(-2).join('/'), bytes(text)])),
    wallMs: Math.round(wallMs * 100) / 100,
    meanMsPerWorkerFetch: Math.round(wallMs / (ITERATIONS * pointCount) * 100) / 100,
    localCpuMs: Math.round((cpu.user + cpu.system) / 10) / 100,
    localHeapDeltaBytesAfterGc: heapAfter - heapBefore,
    coordinatorCalls: counters.coordinatorCalls,
    globalFetchCalls: counters.globalFetchCalls,
    stateSnapshot
  };
}

function archiveBaseline(destination) {
  const archive = spawnSync('git', ['archive', '--format=tar', BASELINE, 'worker'], { cwd: ROOT, maxBuffer: 128 * 1024 * 1024 });
  assert(archive.status === 0, `Unable to archive baseline ${BASELINE}: ${archive.stderr}`);
  const unpacked = spawnSync('tar', ['-xf', '-', '-C', destination], { input: archive.stdout, maxBuffer: 1024 * 1024 });
  assert(unpacked.status === 0, `Unable to unpack baseline worker tree: ${unpacked.stderr}`);
  return path.join(destination, 'worker');
}

async function warmRuntime(module, isAfter) {
  const warm = createFixtureCache(250);
  const request = makeRequests(1)[0];
  const env = environment(warm.cache, { coordinatorCalls: 0, globalFetchCalls: 0 });
  const response = await module.default.fetch(request, env);
  if (response.status !== 200) throw new Error(`Warmup failed with ${response.status}: ${await response.text()}; cache=${JSON.stringify(warm.metrics)}`);
  await response.body?.cancel();
  if (isAfter && typeof module.getWeatherResourceCacheStatsForTesting === 'function') {
    assert(module.getWeatherResourceCacheStatsForTesting('production', env.AWC_COORDINATOR_API, warm.cache), 'Current shared-state stats are unavailable');
  }
}

async function main() {
  assert(typeof global.gc === 'function', 'Run with --expose-gc to make heap deltas comparable.');
  const baselineDir = await mkdtemp(path.join(tmpdir(), 'issue49-current-baseline-'));
  const buildDir = await mkdtemp(path.join(tmpdir(), 'issue49-current-build-'));
  const oldFetch = globalThis.fetch;
  const oldInfo = console.info;
  let globalFetchCalls = 0;
  let coordinatorCalls = 0;
  globalThis.fetch = async () => { globalFetchCalls += 1; throw new Error('Unexpected global fetch during hermetic benchmark.'); };
  console.info = () => undefined;
  try {
    const baselineWorker = archiveBaseline(baselineDir);
    const variants = [
      { name: 'before', source: baselineWorker },
      { name: 'after', source: path.join(ROOT, 'worker') }
    ];
    const results = [];
    for (const variant of variants) {
      const module = await compileAndLoad(variant.name, variant.source, path.join(buildDir, variant.name));
      fixedClock();
      await warmRuntime(module, variant.name === 'after');
      for (const catalogEntries of [250, 10_000]) {
        for (const points of ROUTE_SIZES) {
          const result = await measure(module, catalogEntries, points, variant.name === 'after');
          results.push({ variant: variant.name, ...result });
          coordinatorCalls += result.coordinatorCalls;
        }
      }
      restoreClock();
    }
    assert(globalFetchCalls === 0 && coordinatorCalls === 0, `Unexpected provider traffic: global=${globalFetchCalls}, coordinator=${coordinatorCalls}`);
    process.stdout.write(`${JSON.stringify({
      baseline: BASELINE,
      fixedNow: FIXED_NOW,
      iterations: ITERATIONS,
      upstreamCalls: { globalFetch: globalFetchCalls, coordinator: coordinatorCalls },
      fixtureDescription: 'Synthetic validated edge envelopes: catalog 250/10,000 entries; each of 3 winds cycles has 120 stations x 9 levels and a 12 KB opaque raw field. Five and 28 actual Worker point fetches per route series; no decode/decompression benchmark.',
      results
    }, null, 2)}\n`);
  } finally {
    restoreClock();
    globalThis.fetch = oldFetch;
    console.info = oldInfo;
    await rm(baselineDir, { recursive: true, force: true });
    await rm(buildDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  restoreClock();
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
