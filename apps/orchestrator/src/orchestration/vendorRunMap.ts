/**
 * VendorRunMap — bidirectional lookup between orchestrator RunId and
 * the vendor's per-run identifier.
 *
 * Written when CommandEndpoint calls ProviderAdapter.startRun() and
 * receives a `vendor_run_id`. Read by the IngestionPipeline when a
 * webhook arrives with that vendor_run_id and we need to know which
 * internal run it belongs to.
 *
 * Keyed by (vendor, vendor_run_id) because the same opaque string
 * COULD repeat across vendors.
 * @author asigdel29
 */

import type { RunId, VendorId } from '@agent-canvas/orchestrator-types'

export interface VendorRunMapEntry {
	readonly vendor: VendorId
	readonly vendor_run_id: string
	readonly run_id: RunId
	readonly created_at: string
}

export interface VendorRunMap {
	record(entry: Omit<VendorRunMapEntry, 'created_at'>): Promise<VendorRunMapEntry>
	resolve(vendor: VendorId, vendor_run_id: string): Promise<RunId | null>
}

export class InMemoryVendorRunMap implements VendorRunMap {
	private readonly entries = new Map<string, VendorRunMapEntry>()

	async record(input: Omit<VendorRunMapEntry, 'created_at'>): Promise<VendorRunMapEntry> {
		const key = this.key(input.vendor, input.vendor_run_id)
		const existing = this.entries.get(key)
		if (existing) {
			if (existing.run_id !== input.run_id) {
				throw new Error(
					`vendor_run_id collision: (${input.vendor}, ${input.vendor_run_id}) ` +
						`maps to ${existing.run_id}, cannot rebind to ${input.run_id}`
				)
			}
			return existing
		}
		const entry: VendorRunMapEntry = { ...input, created_at: new Date().toISOString() }
		this.entries.set(key, entry)
		return entry
	}

	async resolve(vendor: VendorId, vendor_run_id: string): Promise<RunId | null> {
		const entry = this.entries.get(this.key(vendor, vendor_run_id))
		return entry?.run_id ?? null
	}

	private key(vendor: VendorId, vendor_run_id: string): string {
		return `${vendor}::${vendor_run_id}`
	}
}
