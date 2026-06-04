/**
 * PostgresVendorRunMap — UPSERT-style record() backed by the
 * vendor_run_map table defined in 002_vendor_run_map.sql.
 *
 * UPSERT semantics:
 *   - Same (vendor, vendor_run_id, run_id) → idempotent no-op return.
 *   - Same (vendor, vendor_run_id) bound to a DIFFERENT run_id → throws
 *     (PK violation surfaces as a collision; we re-read and report).
 * @author asigdel29
 */

import type { RunId, VendorId } from '@agent-canvas/orchestrator-types'
import type {
	VendorRunMap,
	VendorRunMapEntry,
} from '../orchestration/vendorRunMap.js'
import type { SqlClient } from './client.js'

export class PostgresVendorRunMap implements VendorRunMap {
	constructor(private readonly sql: SqlClient) {}

	async record(input: Omit<VendorRunMapEntry, 'created_at'>): Promise<VendorRunMapEntry> {
		const rows = await this.sql<RowShape[]>`
			INSERT INTO vendor_run_map (vendor, vendor_run_id, run_id)
			VALUES (${input.vendor}, ${input.vendor_run_id}, ${input.run_id})
			ON CONFLICT (vendor, vendor_run_id) DO NOTHING
			RETURNING vendor, vendor_run_id, run_id, created_at
		`
		const row = rows[0]
		if (row) return toEntry(row)
		// Conflict — read existing and verify it's the same run_id.
		const existing = await this.sql<RowShape[]>`
			SELECT vendor, vendor_run_id, run_id, created_at
			  FROM vendor_run_map
			 WHERE vendor = ${input.vendor} AND vendor_run_id = ${input.vendor_run_id}
		`
		const e = existing[0]
		if (!e) throw new Error('vendor_run_map insert and read both missed (race)')
		if (e.run_id !== input.run_id) {
			throw new Error(
				`vendor_run_id collision: (${input.vendor}, ${input.vendor_run_id}) ` +
					`maps to ${e.run_id}, cannot rebind to ${input.run_id}`
			)
		}
		return toEntry(e)
	}

	async resolve(vendor: VendorId, vendor_run_id: string): Promise<RunId | null> {
		const rows = await this.sql<{ run_id: string }[]>`
			SELECT run_id FROM vendor_run_map
			 WHERE vendor = ${vendor} AND vendor_run_id = ${vendor_run_id}
		`
		const row = rows[0]
		return row ? (row.run_id as RunId) : null
	}
}

interface RowShape {
	vendor: string
	vendor_run_id: string
	run_id: string
	created_at: Date | string
}

function toEntry(row: RowShape): VendorRunMapEntry {
	return {
		vendor: row.vendor as VendorId,
		vendor_run_id: row.vendor_run_id,
		run_id: row.run_id as RunId,
		created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
	}
}
