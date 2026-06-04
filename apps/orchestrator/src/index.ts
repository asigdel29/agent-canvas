/**
 * @agent-canvas/orchestrator
 *
 * Backend service that owns the source of truth for agent runs. Runs as
 * one persistent Node process (see scripts/server.ts) serving the HTTP
 * API, the SSE multiplayer stream, and the built canvas.
 *
 * Layout:
 *   src/orchestration/   runtime implementations of the state machine,
 *                        event log, projector, reconciler, vault,
 *                        command endpoint, budget gate, input sanitizer
 *   src/connectors/      the GitHub connector + the connector framework
 *   evals/               adversarial eval suite for the taskSpec prompt
 * @author asigdel29
 */

export { applyTransition, NotImplementedError } from './orchestration/runStateMachine.js'
export { getRuntime, resetRuntimeForTesting, type Runtime } from './runtime.js'
