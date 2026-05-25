/**
 * posthog — funnel instrumentation for the canvas operator's
 * journey. Lets the operator (you) watch real TTHW curves once
 * users land on the deploy.
 *
 * Design choices:
 *
 *   - No SDK dependency. We POST to PostHog's `/capture/` REST
 *     endpoint directly. The full SDK adds ~30 KB to the bundle
 *     and brings autocapture which we explicitly do not want for
 *     a canvas that displays user-supplied API keys.
 *
 *   - Env-gated. Without `VITE_POSTHOG_KEY` set, every track()
 *     call is a no-op. Local dev paints zero analytics, prod
 *     paints them when the key is provided.
 *
 *   - sessionStorage distinct id. We generate a UUID per browser
 *     session and use it as PostHog's `distinct_id`. No login-
 *     based identity — we already know the GitHub handle from the
 *     session, but linking it to analytics is a privacy decision
 *     for another day.
 *
 *   - Fire-and-forget. Network failures are silent; analytics
 *     must never break the app.
 *
 *   - Allowlist of event names. Adding a new event means editing
 *     the EventName union; ad-hoc string events are not allowed.
 *     This keeps the funnel inspectable and the schema stable.
 */

const POSTHOG_HOST = 'https://us.i.posthog.com'
const DISTINCT_ID_STORAGE_KEY = 'agent-canvas:posthog_distinct_id'

export type EventName =
	| 'login_started'
	| 'login_completed'
	| 'onboarding_step_welcome'
	| 'onboarding_step_connect'
	| 'onboarding_step_budget'
	| 'onboarding_step_done'
	| 'onboarding_skipped'
	| 'settings_opened'
	| 'settings_saved'
	| 'agent_modal_opened'
	| 'agent_created'
	| 'agent_starter_picked'
	| 'run_started'
	| 'run_succeeded'
	| 'run_failed'
	| 'approval_requested'
	| 'approval_resolved'
	| 'error_toast_shown'

export interface TrackProperties {
	readonly [key: string]: string | number | boolean | null | undefined
}

let posthogKey: string | null = null
let distinctId: string | null = null

function readKey(): string | null {
	if (posthogKey !== null) return posthogKey
	const env = (import.meta as unknown as { env?: Record<string, string> }).env
	posthogKey = env?.['VITE_POSTHOG_KEY'] ?? ''
	return posthogKey || null
}

function readDistinctId(): string {
	if (distinctId) return distinctId
	if (typeof window === 'undefined') {
		distinctId = `srv-${Date.now()}`
		return distinctId
	}
	try {
		const existing = window.sessionStorage.getItem(DISTINCT_ID_STORAGE_KEY)
		if (existing) {
			distinctId = existing
			return existing
		}
		const fresh = `s-${cryptoRandomHex(16)}`
		window.sessionStorage.setItem(DISTINCT_ID_STORAGE_KEY, fresh)
		distinctId = fresh
		return fresh
	} catch {
		distinctId = `s-${cryptoRandomHex(16)}`
		return distinctId
	}
}

function cryptoRandomHex(bytes: number): string {
	const arr = new Uint8Array(bytes)
	crypto.getRandomValues(arr)
	return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Send one analytics event. Never throws. Fire-and-forget; we do
 * not await the response. PostHog's `/capture/` returns 200 with
 * an empty body and rate-limits gracefully.
 */
export function track(event: EventName, properties: TrackProperties = {}): void {
	const key = readKey()
	if (!key) return // analytics disabled
	const body = {
		api_key: key,
		event,
		distinct_id: readDistinctId(),
		properties: {
			$lib: 'agent-canvas-canvas',
			$current_url: typeof window !== 'undefined' ? window.location.href : '',
			...properties,
		},
		timestamp: new Date().toISOString(),
	}
	try {
		void fetch(`${POSTHOG_HOST}/capture/`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
			keepalive: true, // survive navigation
		}).catch(() => {
			/* analytics never breaks the app */
		})
	} catch {
		/* ignore */
	}
}
