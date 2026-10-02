import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server.js';
import { LocalStore } from '../src/store.js';

let app: Awaited<ReturnType<typeof createApp>>;
let store: LocalStore;

beforeAll(async () => {
  store = new LocalStore(resolve(tmpdir(), `compare-test-${process.pid}.json`));
  app = await createApp(store);
});
afterAll(async () => { await app.close(); });

const compare = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/models/compare', payload });

describe('model comparison endpoint', () => {
  it('compares models across all telemetry when flightId is omitted', async () => {
    const response = await compare({ engineId: 'ENG-DEMO-001' });
    expect(response.statusCode).toBe(200);
    const results = response.json() as Array<{ flightId: string | null; sampleCount: number; componentRisks: unknown[]; explanation: string[] }>;
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.flightId).toBeNull();
      expect(result.sampleCount).toBe(72);
      expect(result.componentRisks).toHaveLength(4);
      expect(result.explanation.length).toBeGreaterThan(0);
    }
  });

  it('limits comparison to a single flight and reports the limiting component', async () => {
    const response = await compare({ engineId: 'ENG-DEMO-001', flightId: 'FLIGHT-0313', modelIds: ['health-v2'] });
    expect(response.statusCode).toBe(200);
    const [result] = response.json() as Array<{ flightId: string; sampleCount: number; componentRisks: Array<{ component: string; estimatedCyclesToLimit: number }>; limitingComponent: { component: string; estimatedCyclesToLimit: number }; explanation: string[] }>;
    expect(result.flightId).toBe('FLIGHT-0313');
    expect(result.sampleCount).toBe(12);
    const expected = [...result.componentRisks].sort((a, b) => a.estimatedCyclesToLimit - b.estimatedCyclesToLimit)[0];
    expect(result.limitingComponent.component).toBe(expected.component);
    expect(result.explanation.some(line => line.includes('12 个有效样本'))).toBe(true);
  });

  it('rejects an unknown flightId with a client error', async () => {
    const response = await compare({ engineId: 'ENG-DEMO-001', flightId: 'FLIGHT-9999' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'flight_not_found' });
  });

  it('rejects an unknown model id instead of falling back', async () => {
    const response = await compare({ engineId: 'ENG-DEMO-001', modelIds: ['health-v9'] });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'model_not_found' });
  });

  it('rejects an unknown engine with a client error', async () => {
    const response = await compare({ engineId: 'ENG-UNKNOWN' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'engine_not_found' });
  });

  it('does not write assessments, predictions, or engine status', async () => {
    const before = store.engines.find(item => item.id === 'ENG-DEMO-001')!;
    const snapshot = { status: before.status, currentHealthScore: before.currentHealthScore, lastAssessmentAt: before.lastAssessmentAt };
    const auditCount = store.audit.length;
    const response = await compare({ engineId: 'ENG-DEMO-001', flightId: 'FLIGHT-0313' });
    expect(response.statusCode).toBe(200);
    expect(store.assessments).toHaveLength(0);
    expect(store.predictions).toHaveLength(0);
    expect(store.audit).toHaveLength(auditCount);
    const after = store.engines.find(item => item.id === 'ENG-DEMO-001')!;
    expect({ status: after.status, currentHealthScore: after.currentHealthScore, lastAssessmentAt: after.lastAssessmentAt }).toEqual(snapshot);
  });
});
