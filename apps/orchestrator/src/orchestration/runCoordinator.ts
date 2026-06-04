/**
 * RunCoordinator — drives a queued run into provisioning.
 *
 * Subscribes to the outbox. For each `queued` event:
 *
 *   1. Reads the taskSpec from the event payload to get the required
 *      tool set.
 *   2. Filters providers by tool compatibility (live capability via
 *      ProviderAdapter.getSupportedTools).
 *   3. Picks one via the configured policy (default: first match).
 *   4. Mints scoped credentials for any tools-side connectors the run
 *      will use (delegated to the caller via a hook; the coordinator
 *      itself is vault-agnostic).
 *   5. Calls vendor.startRun(...) and records the vendor_run_map
 *      mapping.
 *   6. Appends a `provisioning` event (vendor pinned in payload +
 *      vendor field) which the projector picks up to update the canvas.
 *
 * Failure modes:
 *   - NoCompatibleVendor: append a `failed` event with reason.
 *   - Vendor 5xx / timeout: bounded retry; the next drain catches
 *     un-acked queued events.
 * @author asigdel29
 */

import {
	NoCompatibleVendorError,
	type RunEvent,
	type RunId,
} from '@agent-canvas/orchestrator-types'
import {
	type ProviderAdapter,
	type StartRunRequest,
} from '@agent-canvas/connector-core'
import { ConnectorRegistry } from '@agent-canvas/connector-core'
import type { EventLog } from './eventLog.js'
import type { Outbox } from './transactionalOutbox.js'
import type { VendorRunMap } from './vendorRunMap.js'

export interface RunCoordinatorDeps {
	readonly registry: ConnectorRegistry
	readonly eventLog: EventLog
	readonly outbox: Outbox
	readonly vendorRunMap: VendorRunMap
	/** Optional minter for scoped credentials passed to the vendor. */
	readonly credentialsFor?: (run_id: RunId) => Promise<Readonly<Record<string, string>>>
}

interface TaskSpecLike {
	required_tools?: readonly string[]
	objective?: string
}

export class RunCoordinator {
	private readonly deps: RunCoordinatorDeps
	private unsubscribe?: () => void

	constructor(deps: RunCoordinatorDeps) {
		this.deps = deps
	}

	/** Install the subscriber; returns the disposal hook. */
	start(): () => void {
		const handler = async (event: RunEvent) => {
			if (event.kind === 'queued') await this.handleQueued(event)
		}
		this.deps.outbox.subscribe(handler)
		this.unsubscribe = () => {
			// Outbox interface does not currently expose unsubscribe; the
			// returned hook is a no-op marker for symmetry. Restarting the
			// runtime is the documented way to drop subscriptions.
		}
		return this.unsubscribe
	}

	/**
	 * Process one queued event. Exposed for direct testing without
	 * going through the outbox drain.
	 */
	async handleQueued(event: RunEvent): Promise<void> {
		const taskSpec = (event.payload as { taskSpec?: TaskSpecLike }).taskSpec ?? {}
		const required = taskSpec.required_tools ?? []

		const vendor = await this.pickVendor(required)
		if (!vendor) {
			await this.emitFailed(event.run_id, new NoCompatibleVendorError([...required]))
			return
		}

		const credentials = this.deps.credentialsFor
			? await this.deps.credentialsFor(event.run_id)
			: {}

		const startReq: StartRunRequest = {
			run_id: event.run_id,
			task_spec: taskSpec as unknown as Readonly<Record<string, unknown>>,
			required_tool_ids: required,
			credentials,
		}

		try {
			const { vendor_run_id } = await vendor.startRun(startReq)
			await this.deps.vendorRunMap.record({
				vendor: vendor.id,
				vendor_run_id,
				run_id: event.run_id,
			})
			const append = await this.deps.eventLog.append({
				run_id: event.run_id,
				kind: 'provisioning',
				payload: { vendor: vendor.id, vendor_run_id },
				vendor: vendor.id,
			})
			const rows = await this.deps.eventLog.read(event.run_id, {
				fromSeq: append.seq,
				limit: 1,
			})
			const row = rows[0]
			if (row) await this.deps.outbox.enqueue(row)
		} catch (err) {
			await this.emitFailed(event.run_id, err)
		}
	}

	private async pickVendor(required: readonly string[]): Promise<ProviderAdapter | null> {
		const vendors = this.deps.registry.allProviders()
		const candidates: ProviderAdapter[] = []
		for (const v of vendors) {
			let supported: readonly string[]
			try {
				supported = await v.getSupportedTools()
			} catch {
				continue
			}
			if (required.every((t) => supported.includes(t))) candidates.push(v)
		}
		// Phase 1 policy: first-fit. Phase 2 layers on a live-health +
		// least-loaded picker (Eng review 1.4 + outside-voice MED).
		return candidates[0] ?? null
	}

	private async emitFailed(run_id: RunId, err: unknown): Promise<void> {
		const reason =
			err instanceof NoCompatibleVendorError
				? `no_compatible_vendor: [${err.required_tools.join(', ')}]`
				: err instanceof Error
					? err.message
					: 'unknown_error'
		const append = await this.deps.eventLog.append({
			run_id,
			kind: 'failed',
			payload: { reason },
		})
		const rows = await this.deps.eventLog.read(run_id, { fromSeq: append.seq, limit: 1 })
		const row = rows[0]
		if (row) await this.deps.outbox.enqueue(row)
	}
}
