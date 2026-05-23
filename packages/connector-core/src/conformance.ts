/**
 * Conformance suite. Every Connector or ProviderAdapter imports and
 * runs this against itself so the strict interface is mechanically
 * enforced (Eng review decision 40 — DRY discipline mechanism).
 *
 * Usage in an adapter's own test file:
 *
 *   import { describe } from 'vitest'
 *   import { runConnectorConformance } from '@agent-canvas/connector-core/conformance'
 *   import { GitHubConnector } from './connector.js'
 *
 *   describe('GitHub adapter conformance', () => {
 *     runConnectorConformance(new GitHubConnector())
 *   })
 */

import { describe, expect, it } from 'vitest'
import type { Connector, ProviderAdapter } from './index.js'

export function runConnectorConformance(connector: Connector): void {
	describe(`Connector[${connector.id}] conformance`, () => {
		it('declares a non-empty id and display_name', () => {
			expect(connector.id).toBeTruthy()
			expect(connector.display_name).toBeTruthy()
		})

		it('exposes the OAuth framework methods', () => {
			expect(typeof connector.oauth.authorize).toBe('function')
			expect(typeof connector.oauth.callback).toBe('function')
			expect(typeof connector.oauth.refresh).toBe('function')
			expect(typeof connector.oauth.revoke).toBe('function')
		})

		it('exposes the webhook framework methods', () => {
			expect(typeof connector.webhook.verifySignature).toBe('function')
			expect(typeof connector.webhook.idempotencyKey).toBe('function')
			expect(typeof connector.webhook.normalize).toBe('function')
		})

		it('every tool declares a safety class', () => {
			for (const tool of connector.tools) {
				expect(['safe', 'destructive', 'irreversible']).toContain(tool.safety)
			}
		})

		// NOTE: per-adapter tests are expected to assert that any tool taking
		// truly arbitrary input (shell command, SQL string, generic HTTP URL)
		// declares safety ∈ {destructive, irreversible}. A static schema sniff
		// here produces too many false positives; the runtime safety classifier
		// (CEO 3.3) is the real defense.

		it('tool ids are unique within the connector', () => {
			const ids = connector.tools.map((t) => t.id)
			expect(new Set(ids).size).toBe(ids.length)
		})

		it('trigger ids are unique within the connector', () => {
			const ids = connector.triggers.map((t) => t.id)
			expect(new Set(ids).size).toBe(ids.length)
		})

		it('sink ids are unique within the connector', () => {
			const ids = connector.sinks.map((s) => s.id)
			expect(new Set(ids).size).toBe(ids.length)
		})
	})
}

export function runProviderAdapterConformance(adapter: ProviderAdapter): void {
	describe(`ProviderAdapter[${adapter.id}] conformance`, () => {
		it('declares a non-empty id and display_name', () => {
			expect(adapter.id).toBeTruthy()
			expect(adapter.display_name).toBeTruthy()
		})

		it('exposes the live capability method', () => {
			expect(typeof adapter.getSupportedTools).toBe('function')
		})

		it('exposes startRun / cancelRun / getStatus', () => {
			expect(typeof adapter.startRun).toBe('function')
			expect(typeof adapter.cancelRun).toBe('function')
			expect(typeof adapter.getStatus).toBe('function')
		})

		it('exposes the vendor-specific webhook framework', () => {
			expect(typeof adapter.webhook.verifySignature).toBe('function')
			expect(typeof adapter.webhook.idempotencyKey).toBe('function')
			expect(typeof adapter.webhook.normalize).toBe('function')
		})
	})
}
