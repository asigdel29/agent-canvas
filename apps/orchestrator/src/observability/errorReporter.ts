/**
 * errorReporter — Sentry-shape error sink that the logger wires
 * into its .error() hook. Without SENTRY_DSN set, every report is
 * a no-op so local dev stays quiet.
 *
 * Why we don't pull in @sentry/node directly:
 *   - The Sentry SDK adds ~120 KB to the bundle
 *   - Sentry auto-instrumentation monkey-patches fetch, which can
 *     leak our user-supplied API keys into Sentry breadcrumbs
 *   - We only need report-on-error — not full APM
 *
 * Shape we POST matches Sentry's envelope endpoint:
 *   https://docs.sentry.io/api/envelopes/
 *
 * Production hardening still on the roadmap (P2):
 *   - sampling rate (currently 100% of errors)
 *   - PII scrubbing pipeline (we currently send err.message verbatim)
 *   - release/environment tags from VERCEL_GIT_COMMIT_SHA + NODE_ENV
 *   - breadcrumbs (currently single-event reports only)
 */

const DEFAULT_DSN = process.env['SENTRY_DSN'] ?? ''

export interface ErrorReport {
	readonly message: string
	readonly level: 'warning' | 'error'
	readonly extra?: Readonly<Record<string, unknown>>
	readonly tags?: Readonly<Record<string, string>>
	readonly fingerprint?: readonly string[]
	readonly error?: {
		readonly type: string
		readonly value: string
		readonly stack?: string
	}
}

/**
 * Returns a function that takes (msg, err, attrs) and reports
 * it to Sentry if SENTRY_DSN is set. Suitable for passing to
 * `logger.addErrorHook(...)`.
 */
export function makeSentryErrorHook(dsn = DEFAULT_DSN): (
	msg: string,
	err: unknown,
	attrs: Record<string, unknown>
) => void {
	if (!dsn) {
		// no-op hook
		return () => undefined
	}
	const parsed = parseSentryDsn(dsn)
	if (!parsed) {
		// invalid DSN — surface once, then fall back to no-op
		// eslint-disable-next-line no-console
		console.warn('[errorReporter] SENTRY_DSN is malformed; reports disabled')
		return () => undefined
	}
	return (msg, err, attrs) => {
		void postToSentry(parsed, buildReport(msg, err, attrs))
	}
}

interface ParsedDsn {
	readonly storeUrl: string
	readonly sentryAuth: string
}

function parseSentryDsn(dsn: string): ParsedDsn | null {
	try {
		const url = new URL(dsn)
		const projectId = url.pathname.replace(/^\//, '')
		if (!projectId || !url.username) return null
		const storeUrl = `${url.protocol}//${url.host}/api/${projectId}/store/`
		const sentryAuth = [
			`Sentry sentry_version=7`,
			`sentry_key=${url.username}`,
			`sentry_client=agent-canvas/0.0.1`,
		].join(', ')
		return { storeUrl, sentryAuth }
	} catch {
		return null
	}
}

function buildReport(
	msg: string,
	err: unknown,
	attrs: Record<string, unknown>
): ErrorReport {
	const tags =
		typeof attrs['route'] === 'string' ? { route: attrs['route'] as string } : null
	const base: ErrorReport = tags
		? {
				message: msg,
				level: 'error',
				extra: stripErr(attrs),
				tags,
				fingerprint: [msg],
			}
		: {
				message: msg,
				level: 'error',
				extra: stripErr(attrs),
				fingerprint: [msg],
			}
	if (err instanceof Error) {
		const errorBlock = err.stack
			? { type: err.name, value: err.message, stack: err.stack }
			: { type: err.name, value: err.message }
		return { ...base, error: errorBlock }
	}
	if (typeof err === 'string') {
		return { ...base, error: { type: 'Error', value: err } }
	}
	return base
}

function stripErr(attrs: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(attrs)) {
		if (k === 'err') continue
		out[k] = v
	}
	return out
}

async function postToSentry(parsed: ParsedDsn, report: ErrorReport): Promise<void> {
	const body: Record<string, unknown> = {
		event_id: cryptoRandomHex(16),
		timestamp: new Date().toISOString(),
		platform: 'node',
		level: report.level,
		message: report.message,
		fingerprint: report.fingerprint,
		extra: report.extra,
		tags: report.tags,
	}
	if (report.error) {
		body['exception'] = {
			values: [
				{
					type: report.error.type,
					value: report.error.value,
					stacktrace: report.error.stack
						? { frames: [{ filename: report.error.stack.slice(0, 2_000) }] }
						: undefined,
				},
			],
		}
	}
	try {
		await fetch(parsed.storeUrl, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-sentry-auth': parsed.sentryAuth,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(2_000),
			keepalive: true,
		})
	} catch {
		// network error or 4xx — silently drop. Error reporting must
		// never amplify failures.
	}
}

function cryptoRandomHex(bytes: number): string {
	const buf = new Uint8Array(bytes)
	crypto.getRandomValues(buf)
	return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}
