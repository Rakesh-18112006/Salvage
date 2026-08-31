/**
 * THE ONE CLAIM THIS PROJECT MUST NOT GET WRONG.
 *
 * A run where the model answered nothing must never be describable as an AI or
 * model-driven result. That is easy to get wrong by accident, because "we passed
 * --use-model" and "we constructed a GeminiClient" are both statements of INTENT, and on
 * a quota-limited key every call can fail while the output still says "Gemini" at the top.
 *
 * These tests pin the derivation to what was OBSERVED.
 */
import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import { AgentPolicy } from '../src/agent/agentPolicy.ts';
import { provenanceOf } from '../src/agent/provenance.ts';
import {
  LlmUnavailableError,
  type DecisionModel,
  type GeminiUsage,
  type GenerateArgs,
  type GenerateResult,
} from '../src/agent/geminiClient.ts';
import { buildAtRiskPopulation } from '../src/sim/population.ts';
import { runArm } from '../src/engine/runner.ts';

const SEED = 'provenance';

function usage(over: Partial<GeminiUsage> = {}): GeminiUsage {
  return {
    calls: 0,
    failedCalls: 0,
    promptTokens: 0,
    outputTokens: 0,
    totalLatencyMs: 0,
    byModel: {},
    ...over,
  };
}

/** A model that always fails, as a quota-exhausted key does. */
class DeadModel implements DecisionModel {
  calls = 0;
  async generateJson<T>(): Promise<GenerateResult<T>> {
    this.calls++;
    throw new LlmUnavailableError('quota exceeded', 429);
  }
}

/** A model that always answers. */
class LiveModel implements DecisionModel {
  calls = 0;
  async generateJson<T>(_a: GenerateArgs): Promise<GenerateResult<T>> {
    this.calls++;
    return {
      value: {
        diagnosis: 'INSUFFICIENT_FUNDS',
        confidence: 0.8,
        strategy: 'TIME_SHIFT_TO_INFLOW',
        alsoNotify: false,
        rationale: 'wait for the inflow',
      } as T,
      model: 'stub',
      latencyMs: 1,
      promptTokens: 1,
      outputTokens: 1,
      attempts: 1,
    };
  }
}

describe('result provenance', () => {
  test('a deterministic-only run is never model-driven', () => {
    const p = provenanceOf({
      modelEnabled: false,
      stats: {
        decisions: 500,
        triagedDeterministically: 200,
        modelCalls: 0,
        cacheHits: 0,
        fallbacks: 300,
      },
      usage: null,
    });
    assert.equal(p.kind, 'deterministic-only');
    assert.equal(p.isModelDriven, false);
    assert.match(p.label, /DETERMINISTIC ONLY/);
    assert.match(p.detail, /must NOT be described as AI or model-driven/);
  });

  test('a run where the model answered NOTHING is fallback-only, not model-driven', () => {
    // The exact situation a quota-exhausted key produces.
    const p = provenanceOf({
      modelEnabled: true,
      stats: {
        decisions: 237,
        triagedDeterministically: 97,
        modelCalls: 0,
        cacheHits: 0,
        fallbacks: 140,
      },
      usage: usage({ failedCalls: 206 }),
    });
    assert.equal(p.kind, 'fallback-only');
    assert.equal(p.isModelDriven, false);
    assert.match(p.label, /FALLBACK ONLY/);
    assert.match(p.detail, /must NOT be reported as a model-driven result/);
    assert.match(p.detail, /206 failed/);
  });

  test('a run the fallback mostly carried is degraded, not model-driven', () => {
    const p = provenanceOf({
      modelEnabled: true,
      stats: {
        decisions: 200,
        triagedDeterministically: 40,
        modelCalls: 10,
        cacheHits: 20,
        fallbacks: 130,
      },
      usage: usage({ calls: 10, failedCalls: 90 }),
    });
    assert.equal(p.kind, 'model-degraded');
    assert.equal(
      p.isModelDriven,
      false,
      'a run the fallback carried must not be sold as an AI result',
    );
  });

  test('a genuine model run is model-driven, and says how many calls', () => {
    const p = provenanceOf({
      modelEnabled: true,
      stats: {
        decisions: 500,
        triagedDeterministically: 200,
        modelCalls: 40,
        cacheHits: 250,
        fallbacks: 10,
      },
      usage: usage({ calls: 40 }),
    });
    assert.equal(p.kind, 'model-driven');
    assert.equal(p.isModelDriven, true);
    assert.match(p.label, /40 live calls/);
  });

  test('cached decisions count as model-authored, because the model authored them', () => {
    // A cache hit replays a decision the model made once for that exact context. It is
    // not a fallback, and calling it one would understate the model's contribution as
    // badly as the reverse overstates it.
    const p = provenanceOf({
      modelEnabled: true,
      stats: {
        decisions: 100,
        triagedDeterministically: 0,
        modelCalls: 5,
        cacheHits: 90,
        fallbacks: 5,
      },
      usage: usage({ calls: 5 }),
    });
    assert.equal(p.kind, 'model-driven');
  });

  // --- end to end, against the real agent ------------------------------------

  test('an agent whose model is dead reports fallback-only after a real batch', async () => {
    const population = buildAtRiskPopulation(SEED, 40);
    const model = new DeadModel();
    const agent = new AgentPolicy({ world: population.world, seed: SEED, client: model });

    await runArm(population, agent, 4);

    const p = provenanceOf({ modelEnabled: true, stats: agent.stats, usage: null });
    assert.equal(agent.stats.modelCalls, 0, 'no model call succeeded');
    assert.ok(agent.stats.fallbacks > 0, 'the fallback carried the run');
    assert.equal(p.isModelDriven, false);
    assert.equal(p.kind, 'fallback-only');
  });

  test('an agent with a working model reports model-driven after a real batch', async () => {
    const population = buildAtRiskPopulation(SEED, 40);
    const model = new LiveModel();
    const agent = new AgentPolicy({ world: population.world, seed: SEED, client: model });

    await runArm(population, agent, 4);

    const p = provenanceOf({ modelEnabled: true, stats: agent.stats, usage: null });
    assert.ok(agent.stats.modelCalls > 0, 'the model answered');
    assert.equal(p.isModelDriven, true);
    assert.equal(p.kind, 'model-driven');
  });

  test('deterministicOnly never calls the model even if one is supplied', async () => {
    const population = buildAtRiskPopulation(SEED, 30);
    const model = new LiveModel();
    const agent = new AgentPolicy({
      world: population.world,
      seed: SEED,
      client: model,
      deterministicOnly: true,
    });

    await runArm(population, agent, 4);

    assert.equal(model.calls, 0, '--deterministic-only must not reach the model at all');
    assert.equal(agent.stats.modelCalls, 0);
    const p = provenanceOf({ modelEnabled: false, stats: agent.stats, usage: null });
    assert.equal(p.isModelDriven, false);
  });
});
