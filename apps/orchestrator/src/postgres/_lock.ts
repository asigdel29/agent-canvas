/**
 * Stable 64-bit hash of a run_id for use with pg_advisory_xact_lock().
 *
 * pg_advisory_xact_lock takes a bigint. JS numbers can't represent the
 * full 64-bit range safely, so we fold into a 32-bit hash (which Postgres
 * accepts as a 32-bit advisory lock key). Collisions on the 32-bit
 * space are statistically negligible at our run-id volume and only
 * cause spurious serialization, never correctness issues.
 * @author asigdel29
 */

export function hashRunIdForLock(run_id: string): number {
	let h = 0
	for (let i = 0; i < run_id.length; i += 1) {
		h = (h * 31 + run_id.charCodeAt(i)) | 0
	}
	return h
}
