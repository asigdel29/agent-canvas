/**
 * Postgres client setup.
 *
 * The orchestrator is deployed on Vercel Functions; the recommended
 * Marketplace data integration is Neon. Two connection strings are
 * supported:
 *
 *   DATABASE_URL                  transaction-pooled (default)
 *   DATABASE_URL_SESSION          session-mode pool (used for LISTEN/
 *                                 NOTIFY long-lived connections)
 *
 * The `postgres` library handles connection pooling and prepared
 * statements; we just hand it the URL.
 * @author asigdel29
 */

import postgres from 'postgres'

export type SqlClient = ReturnType<typeof postgres>

export interface ClientOptions {
	readonly url?: string
	/** When true, applies session-mode tuning useful for LISTEN/NOTIFY. */
	readonly session?: boolean
}

export function createSqlClient(opts: ClientOptions = {}): SqlClient {
	const url =
		opts.url ??
		(opts.session ? process.env['DATABASE_URL_SESSION'] : process.env['DATABASE_URL'])
	if (!url) {
		const which = opts.session ? 'DATABASE_URL_SESSION' : 'DATABASE_URL'
		throw new Error(`missing ${which} environment variable`)
	}
	return postgres(url, {
		max: opts.session ? 4 : 16,
		idle_timeout: opts.session ? 0 : 20,
		max_lifetime: opts.session ? 0 : 60 * 30,
		prepare: true,
	})
}
