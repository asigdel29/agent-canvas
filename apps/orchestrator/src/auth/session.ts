/**
 * Session extraction helper.
 *
 * Pulls a bearer token out of the Authorization header, verifies it
 * via the JWT layer, and returns the SessionClaims (or null if the
 * token is missing or invalid).
 *
 * Route handlers use this to resolve the actor's UserId before
 * calling into the CommandEndpoint.
 * @author asigdel29
 */

import {
	JwtVerificationError,
	verifySession,
	type SessionClaims,
} from './jwt.js'

export function extractSession(req: Request, secret: string): SessionClaims | null {
	const header = req.headers.get('authorization')
	if (!header) return null
	const match = header.match(/^bearer\s+(.+)$/i)
	if (!match) return null
	const token = match[1]!.trim()
	try {
		return verifySession(token, secret)
	} catch (err) {
		if (err instanceof JwtVerificationError) return null
		throw err
	}
}
