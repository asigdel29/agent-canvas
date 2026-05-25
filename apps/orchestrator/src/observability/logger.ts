/**
 * logger — structured JSON logging for the orchestrator.
 *
 * Every log line is one JSON object on its own line. Vercel
 * Logs, Datadog, Loki, and every other log-aggregation tool
 * understand this shape out of the box. The orchestrator
 * previously sprinkled `console.warn(...)` calls with arbitrary
 * shapes; this module is the single source of truth.
 *
 * Shape:
 *
 *   { ts, level, msg, ...attributes }
 *
 *   ts          ISO 8601 timestamp
 *   level       'debug' | 'info' | 'warn' | 'error'
 *   msg         short human-readable summary
 *   ...attrs    structured fields the caller supplies
 *
 * Level gating is via LOG_LEVEL env (default 'info'). Levels
 * below the threshold no-op so production deploys can stay
 * quiet about debug noise without changing call sites.
 *
 * Error logging:
 *   logger.error('msg', { err }) extracts name/message/stack
 *   from err automatically, so callers do not stringify by hand.
 *   The errorReporter (Sentry-shape) sees the same object via
 *   its own hook.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
}

export interface LogAttrs {
	readonly [key: string]: unknown
	readonly err?: unknown
}

/**
 * Mutable singleton state. Callers normally use the default
 * `logger` export; tests substitute via `createLogger()`.
 */
class Logger {
	private threshold: number
	private readonly sinks: ((line: string) => void)[]
	private readonly errorHooks: ((msg: string, err: unknown, attrs: LogAttrs) => void)[]

	constructor(level: LogLevel = 'info') {
		this.threshold = LEVEL_RANK[level]
		this.sinks = [(line) => process.stdout.write(`${line}\n`)]
		this.errorHooks = []
	}

	setLevel(level: LogLevel): void {
		this.threshold = LEVEL_RANK[level]
	}

	/** Add a sink. Default sink is stdout; tests inject collectors. */
	addSink(sink: (line: string) => void): void {
		this.sinks.push(sink)
	}

	/** Add an error-side hook (e.g. Sentry). Called for every .error(). */
	addErrorHook(hook: (msg: string, err: unknown, attrs: LogAttrs) => void): void {
		this.errorHooks.push(hook)
	}

	debug(msg: string, attrs: LogAttrs = {}): void {
		this.write('debug', msg, attrs)
	}
	info(msg: string, attrs: LogAttrs = {}): void {
		this.write('info', msg, attrs)
	}
	warn(msg: string, attrs: LogAttrs = {}): void {
		this.write('warn', msg, attrs)
	}
	error(msg: string, attrs: LogAttrs = {}): void {
		this.write('error', msg, attrs)
		const err = attrs.err
		if (err !== undefined) {
			for (const hook of this.errorHooks) {
				try {
					hook(msg, err, attrs)
				} catch {
					// reporter failures never kill the request
				}
			}
		}
	}

	private write(level: LogLevel, msg: string, attrs: LogAttrs): void {
		if (LEVEL_RANK[level] < this.threshold) return
		const line: Record<string, unknown> = {
			ts: new Date().toISOString(),
			level,
			msg,
		}
		// Inline non-err attrs first so they survive an err that
		// would otherwise dominate the output.
		for (const [k, v] of Object.entries(attrs)) {
			if (k === 'err') continue
			line[k] = v
		}
		if (attrs.err !== undefined) {
			line['err'] = serializeError(attrs.err)
		}
		try {
			const serialized = JSON.stringify(line)
			for (const sink of this.sinks) {
				try {
					sink(serialized)
				} catch {
					// drop the line for that sink; never crash the caller
				}
			}
		} catch {
			// JSON.stringify can throw on circular refs; fall back to a
			// safe summary that always serializes.
			const safe = JSON.stringify({
				ts: new Date().toISOString(),
				level,
				msg,
				err: '(unserializable attributes)',
			})
			for (const sink of this.sinks) {
				try {
					sink(safe)
				} catch {
					/* ignore */
				}
			}
		}
	}
}

/**
 * Best-effort error → JSON. Extracts name/message/stack for
 * Errors; falls back to String(err) for primitives. Truncates
 * stack to keep log lines under typical 4KB platform caps.
 */
function serializeError(err: unknown): Record<string, unknown> {
	if (err instanceof Error) {
		const stack = err.stack ?? ''
		return {
			name: err.name,
			message: err.message,
			stack: stack.length > 2_000 ? `${stack.slice(0, 2_000)}…` : stack,
		}
	}
	if (typeof err === 'object' && err !== null) {
		try {
			return JSON.parse(JSON.stringify(err)) as Record<string, unknown>
		} catch {
			return { value: String(err) }
		}
	}
	return { value: String(err) }
}

export function createLogger(level: LogLevel = 'info'): Logger {
	return new Logger(level)
}

/**
 * Default logger. Level read from LOG_LEVEL env (lowercase),
 * defaults to 'info'. Module load is the only point that reads
 * the env; runtime callers can override via setLevel.
 */
function readLevelFromEnv(): LogLevel {
	const raw = (process.env['LOG_LEVEL'] ?? '').toLowerCase()
	if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw
	return 'info'
}

export const logger = new Logger(readLevelFromEnv())

export type { Logger }
