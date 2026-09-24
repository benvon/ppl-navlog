import { describe, expect, it } from 'vitest';
import { selectArrivalTafWind } from './arrival-taf-wind';
import type { TafAnswer, TafWindGroup } from '../../worker/api/contracts';

const group = (kind: TafWindGroup['kind'], from: string, until: string, direction: number | null, speed: number | null, windDirectionType: TafWindGroup['windDirectionType'] = direction === null ? 'missing' : 'fixed'): TafWindGroup => ({ kind, fromUtc: from, untilUtc: until, windDirectionType, windFromDegTrue: direction, windSpeedKt: speed, gustKt: speed === null ? null : speed + 20, probabilityPercent: kind === 'PROB' ? 30 : null, raw: `${kind} fixture` });
const taf = (groups: TafWindGroup[]): TafAnswer => ({ stationIcao: 'KORD', issuedAt: '2026-09-22T00:00:00.000Z', validFrom: '2026-09-22T00:00:00.000Z', validUntil: '2026-09-23T00:00:00.000Z', rawTaf: 'TAF KORD fixture', groups, requestId: '11111111-1111-4111-8111-111111111111' });
const arrival = '2026-09-22T03:00:00.000Z';

describe('selectArrivalTafWind', () => {
  it('uses a conditional wind at arrival and preserves candidates without gust substitution', () => {
    const input = taf([group('prevailing', '2026-09-22T00:00:00.000Z', '2026-09-23T00:00:00.000Z', 270, 10), group('TEMPO', '2026-09-22T02:00:00.000Z', '2026-09-22T04:00:00.000Z', 90, 15)]);
    const selected = selectArrivalTafWind(input, arrival, 270, 100);
    expect(selected.selectedGroup.kind).toBe('TEMPO');
    expect(selected.candidates).toHaveLength(1);
    expect(selected.groundspeedKt).toBe(Math.min(...selected.candidates.map((candidate) => candidate.groundspeedKt)));
    expect(selected.candidates.map((candidate) => candidate.effectiveWind.speedKt)).toEqual([15]);
  });

  it('inherits a missing conditional wind and treats VRB speed as direct headwind', () => {
    const inherited = taf([group('prevailing', '2026-09-22T00:00:00.000Z', '2026-09-23T00:00:00.000Z', 270, 10), group('PROB', '2026-09-22T02:00:00.000Z', '2026-09-22T04:00:00.000Z', null, null)]);
    expect(selectArrivalTafWind(inherited, arrival, 270, 100).candidates[0]?.effectiveWind).toEqual({ directionFromDegTrue: 270, speedKt: 10 });
    const variable = taf([group('prevailing', '2026-09-22T00:00:00.000Z', '2026-09-23T00:00:00.000Z', 0, 5), group('TEMPO', '2026-09-22T02:00:00.000Z', '2026-09-22T04:00:00.000Z', null, 12, 'variable')]);
    const selected = selectArrivalTafWind(variable, arrival, 270, 100);
    expect(selected.candidates.find((candidate) => candidate.group.kind === 'TEMPO')).toMatchObject({ directionAssumption: 'VRB treated as direct headwind', sourceWind: { directionType: 'variable', directionFromDegTrue: null, speedKt: 12 }, effectiveWind: { directionFromDegTrue: 270, speedKt: 12 }, groundspeedKt: 88 });
    const inheritedVariable = taf([group('prevailing', '2026-09-22T00:00:00.000Z', '2026-09-23T00:00:00.000Z', null, 7, 'variable'), group('TEMPO', '2026-09-22T02:00:00.000Z', '2026-09-22T04:00:00.000Z', null, null)]);
    expect(selectArrivalTafWind(inheritedVariable, arrival, 270, 100).candidates[0]).toMatchObject({ directionAssumption: 'VRB treated as direct headwind', inheritedWindGroup: { windDirectionType: 'variable' }, effectiveWind: { directionFromDegTrue: 270, speedKt: 7 } });
  });

  it('chooses the lowest groundspeed among overlapping conditional groups with stable evidence', () => {
    const input = taf([group('prevailing', '2026-09-22T00:00:00.000Z', '2026-09-23T00:00:00.000Z', 0, 10), group('TEMPO', '2026-09-22T02:00:00.000Z', '2026-09-22T04:00:00.000Z', 90, 12), group('PROB', '2026-09-22T02:30:00.000Z', '2026-09-22T04:00:00.000Z', 270, 18)]);
    const selected = selectArrivalTafWind(input, arrival, 270, 100);
    expect(selected.candidates).toHaveLength(2);
    expect(selected.selectedGroup.kind).toBe('PROB');
    expect(selected.groundspeedKt).toBe(Math.min(...selected.candidates.map((candidate) => candidate.groundspeedKt)));
  });

  it('rejects an arrival outside validity or equal-start conflicting base groups', () => {
    const base = group('prevailing', '2026-09-22T00:00:00.000Z', '2026-09-23T00:00:00.000Z', 270, 10);
    expect(() => selectArrivalTafWind(taf([base]), '2026-09-23T00:00:00.000Z', 270, 100)).toThrow(/outside/);
    expect(() => selectArrivalTafWind({ ...taf([base]), issuedAt: '2026-09-22T04:00:00.000Z' }, arrival, 270, 100)).toThrow(/issuance/);
    expect(() => selectArrivalTafWind(taf([{ ...base, untilUtc: 'not-a-time' }]), arrival, 270, 100)).toThrow(/timing/);
    expect(() => selectArrivalTafWind(taf([base, group('FM', '2026-09-22T00:00:00.000Z', '2026-09-22T05:00:00.000Z', 90, 8)]), arrival, 270, 100)).toThrow(/conflicting/);
  });

  it('uses the latest FM base when it overlaps the original prevailing span and conditional wind is omitted', () => {
    const input = taf([group('prevailing', '2026-09-22T00:00:00.000Z', '2026-09-23T00:00:00.000Z', 270, 10), group('FM', '2026-09-22T02:00:00.000Z', '2026-09-23T00:00:00.000Z', 90, 14), group('TEMPO', '2026-09-22T02:00:00.000Z', '2026-09-22T04:00:00.000Z', null, null)]);
    const selected = selectArrivalTafWind(input, arrival, 270, 100);
    expect(selected.candidates).toHaveLength(1);
    expect(selected.candidates[0]).toMatchObject({ group: { kind: 'TEMPO' }, inheritedWindGroup: { kind: 'FM', windFromDegTrue: 90, windSpeedKt: 14 }, effectiveWind: { directionFromDegTrue: 90, speedKt: 14 } });
  });
});
