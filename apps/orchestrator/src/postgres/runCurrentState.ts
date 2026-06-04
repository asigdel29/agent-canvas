/**
 * PostgresRunCurrentStateCache — denormalized "current run state" row.
 *
 * Updated in the SAME transaction as every event_log append. The
 * monotonicity predicate is mandatory (Eng review 42 + outside-voice):
 *
 *   UPDATE run_current_state
 *      SET ...
 *    WHERE run_id = $1 AND last_seq < $new_last_seq
 *
 * Without that predicate, a delayed re-apply of an old event silently
 * downgrades state. Tests on the in-memory implementation enforce the
 * same semantics; this adapter ports them to SQL.
 * @author asigdel29
 */

import type {
	RunCurrentState,
	RunId,
} from '@agent-canvas/orchestrator-types'
import type { RunCurrentStateCache } from '../orchestration/runCurrentState.js'
import type { SqlClient } from './client.js'

export class PostgresRunCurrentStateCache implements RunCurrentStateCache {
	constructor(private readonly sql: SqlClient) {}

	async get(run_id: RunId): Promise<RunCurrentState | null> {
		const rows = await this.sql<RunCurrentState[]>`
			SELECT run_id, status, vendor, last_seq, last_event_at, schema_version, updated_at
			  FROM run_current_state
			 WHERE run_id = ${run_id}
		`
		return rows[0] ?? null
	}

	async insertInitial(initial: RunCurrentState): Promise<void> {
		await this.sql`
			INSERT INTO run_current_state
				(run_id, status, vendor, last_seq, last_event_at, schema_version, updated_at)
			VALUES
				(${initial.run_id}, ${initial.status}, ${initial.vendor ?? null},
				 ${initial.last_seq}, ${initial.last_event_at},
				 ${initial.schema_version}, ${initial.updated_at})
		`
	}

	async updateIfNewer(next: RunCurrentState): Promise<RunCurrentState | null> {
		const rows = await this.sql<RunCurrentState[]>`
			UPDATE run_current_state
			   SET status         = ${next.status},
			       vendor         = ${next.vendor ?? null},
			       last_seq       = ${next.last_seq},
			       last_event_at  = ${next.last_event_at},
			       schema_version = ${next.schema_version},
			       updated_at     = ${next.updated_at}
			 WHERE run_id   = ${next.run_id}
			   AND last_seq < ${next.last_seq}
			RETURNING run_id, status, vendor, last_seq, last_event_at, schema_version, updated_at
		`
		return rows[0] ?? null
	}
}
