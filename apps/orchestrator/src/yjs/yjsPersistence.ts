/**
 * Postgres-backed durability for collaborative-canvas documents.
 *
 * Returns null when DATABASE_URL is unset (local/in-memory dev), in
 * which case rooms live only for the process lifetime — fine for a
 * single developer, and the WebSocket layer degrades gracefully.
 * @author asigdel29
 */

import { createSqlClient } from '../postgres/client.js'
import type { YjsPersistence } from './yjsServer.js'

export function createYjsPersistence(): YjsPersistence | null {
	if (!process.env['DATABASE_URL']) return null
	const sql = createSqlClient()
	return {
		async load(room: string): Promise<Uint8Array | null> {
			const rows = await sql<{ doc: Buffer }[]>`
				SELECT doc FROM yjs_documents WHERE workspace_id = ${room} LIMIT 1
			`
			const row = rows[0]
			return row ? new Uint8Array(row.doc) : null
		},
		async store(room: string, state: Uint8Array): Promise<void> {
			const buf = Buffer.from(state)
			await sql`
				INSERT INTO yjs_documents (workspace_id, doc, updated_at)
				VALUES (${room}, ${buf}, now())
				ON CONFLICT (workspace_id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()
			`
		},
	}
}
