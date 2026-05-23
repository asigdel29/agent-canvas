/**
 * @agent-canvas/orchestrator
 *
 * Backend service that owns the source of truth for agent runs.
 * Deployed on Vercel (post-Eng-review-inversion: all-Vercel).
 *
 * Layout:
 *   src/orchestration/   runtime implementations of the state machine,
 *                        event log, projector, reconciler, vault,
 *                        command endpoint, billing gate, input sanitizer
 *   src/connectors/      8 third-party adapters + 2 vendor adapters
 *   evals/               adversarial eval suite for the taskSpec prompt
 *
 * Most modules under src/orchestration are STUBS in this initial scaffold;
 * each declares its public API and throws NotImplementedError until the
 * Phase 1 implementation PRs land it.
 */

export { applyTransition, NotImplementedError } from './orchestration/runStateMachine.js'
export { getRuntime, resetRuntimeForTesting, type Runtime } from './runtime.js'
