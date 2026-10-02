import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDemoTelemetry, demoEngine, demoModels } from '../src/demo-data.js';
import { assessEngine } from '../src/health.js';
import { createApp } from '../src/server.js';
import { LocalStore } from '../src/store.js';

const store = new LocalStore(join(mkdtempSync(join(tmpdir(), 'compare-test-')), 'state.json'));
const app = await createApp(store);
afterAll(async () => app.close());

const compare = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/models/compare', payload });
const components = ['hot_section', 'compressor', 'bearing', 'lubrication'];

describe('model comparison endpoint', () => {
  it('compares all models over full telemetry when flightId is omitted', async () => {
    const response = await compare({ engineId: demoEngine.id });
    expect(response.statusCode).toBe(200);
    const results = response.json() as Array<Record<string, unknown>>;
    expect(results).toHaveLength(demoModels.length);
    const full = assessEngine(demoEngine, createDemoTelemetry(), demoModels[1], 2);
    const v2 = results.find(item => item.modelId === 'health-v2')!;
    expect(v2.flightId).toBeNull();
    expect(v2.healthScore).toBe(full.healthScore);
    expect(v2.componentRisks).toHaveLength(4);
    expect(components).toContain(v2.limitingComponent);
    expect((v2.explanation as string[]).length).toBeGreaterThan(0);
  });

  it('scopes the comparison to a single flight and explains it', async () => {
    const flightId = 'FLIGHT-0310';
    const response = await compare({ engineId: demoEngine.id, flightId, modelIds: ['health-v1', 'health-v2'] });
    expect(response.statusCode).toBe(200);
    const results = response.json() as Array<Record<string, unknown>>;
    expect(results).toHaveLength(2);
    const rows = createDemoTelemetry().filter(item => item.flightId === flightId);
    for (const [index, model] of demoModels.entries()) {
      const expected = assessEngine(demoEngine, rows, model, 2);
      expect(results[index].flightId).toBe(flightId);
      expect(results[index].healthScore).toBe(expected.healthScore);
      expect(results[index].componentRisks).toEqual(expected.componentRisks);
      expect(results[index].limitingComponent).toBe([...expected.componentRisks].sort((a, b) => a.estimatedCyclesToLimit - b.estimatedCyclesToLimit)[0].component);
      expect((results[index].explanation as string[])[0]).toContain(flightId);
    }
  });

  it('returns a client error for an unknown flight', async () => {
    const response = await compare({ engineId: demoEngine.id, flightId: 'FLIGHT-9999' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'flight_not_found' });
  });

  it('returns a client error for an unknown model instead of falling back', async () => {
    const response = await compare({ engineId: demoEngine.id, modelIds: ['health-v1', 'health-v9'] });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'model_not_found' });
  });

  it('returns a client error for an unknown engine or missing engineId', async () => {
    expect((await compare({ engineId: 'ENG-UNKNOWN' })).statusCode).toBe(404);
    expect((await compare({})).statusCode).toBe(400);
  });

  it('never writes assessments, predictions or engine state', async () => {
    await compare({ engineId: demoEngine.id });
    await compare({ engineId: demoEngine.id, flightId: 'FLIGHT-0312' });
    expect(store.assessments).toHaveLength(0);
    expect(store.predictions).toHaveLength(0);
    const engine = store.engines.find(item => item.id === demoEngine.id)!;
    expect(engine.status).toBe('watch');
    expect(engine.currentHealthScore).toBe(82);
    expect(engine.lastAssessmentAt).toBeUndefined();
  });
});
