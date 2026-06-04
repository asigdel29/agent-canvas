/**
 * Vault — owned KMS-backed credential storage.
 *
 * Two surfaces:
 *
 *   1. Long-lived storage: encrypt OAuth refresh tokens, app-installation
 *      secrets, etc., at rest. The crypto primitive is provided by an
 *      external KMS (AWS KMS, GCP KMS, an HSM, etc.).
 *
 *   2. Per-run scoped credential minting: for each agent run, mint the
 *      narrowest, shortest-lived credential the provider supports (GitHub
 *      App installation tokens scoped via permissions ~1hr; equivalent
 *      per provider). Vendor receives ONLY the scoped credential, never
 *      the long-lived secret.
 *
 * Vault is on the Vercel side (decision 1.1). Workers never touch
 * long-lived credentials. KMS reads are cached with a bounded TTL
 * (outside-voice HIGH on thundering-herd KMS QPS).
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

import {
	VaultMintError,
	VaultUnavailableError,
} from '@agent-canvas/connector-core'
import type { ProviderId, RunId, UserId } from '@agent-canvas/orchestrator-types'

export interface VaultEntry {
	readonly id: string
	readonly user_id: UserId
	readonly provider: ProviderId
	/** Opaque ciphertext from the KMS. */
	readonly ciphertext: string
	/** When the long-lived secret was last rotated. */
	readonly rotated_at: string
	/** When the long-lived secret is expected to expire (provider-dependent). */
	readonly expires_at?: string
}

export interface ScopedCredential {
	readonly access_token: string
	readonly expires_at: string
	readonly scope: string
	/** Identifier the user-visible UI shows alongside agent actions. */
	readonly principal_label: string
}

export interface MintRequest {
	readonly run_id: RunId
	readonly user_id: UserId
	readonly provider: ProviderId
	/** Caller-supplied scope hint; provider clamps to allowable. */
	readonly requested_scope: string
}

export interface Vault {
	store(entry: Omit<VaultEntry, 'id' | 'rotated_at'>): Promise<VaultEntry>
	retrieve(user_id: UserId, provider: ProviderId): Promise<VaultEntry | null>
	revoke(id: string): Promise<void>
	mintScopedCredential(req: MintRequest): Promise<ScopedCredential>
}

// ─────────────────────────────────────────────────────────────────────
// KMS abstraction. Production wires this to AWS KMS or equivalent;
// tests use the in-memory stub which performs no encryption.
// ─────────────────────────────────────────────────────────────────────

export interface KmsClient {
	encrypt(plaintext: string): Promise<string>
	decrypt(ciphertext: string): Promise<string>
}

/**
 * StubKmsClient — base64 wrapping, NO actual encryption. Tests only.
 */
export class StubKmsClient implements KmsClient {
	async encrypt(plaintext: string): Promise<string> {
		return 'stub:' + Buffer.from(plaintext, 'utf8').toString('base64')
	}
	async decrypt(ciphertext: string): Promise<string> {
		if (!ciphertext.startsWith('stub:')) throw new VaultUnavailableError('stub ciphertext expected')
		return Buffer.from(ciphertext.slice(5), 'base64').toString('utf8')
	}
}

/**
 * LocalKmsClient — AES-256-GCM encryption with a key held in process env.
 *
 * The self-hosting replacement for an external KMS (AWS KMS, GCP KMS,
 * an HSM). The 32-byte key is supplied as a hex string via VAULT_KEY and
 * never leaves the process. Ciphertext is `local:<iv>:<tag>:<data>`, all
 * hex. AES-GCM gives confidentiality plus an authentication tag, so a
 * tampered ciphertext fails to decrypt rather than returning garbage.
 *
 * Intended for a single-tenant internal deployment where the orchestrator
 * runs as one trusted process. For multi-tenant or compliance-bound
 * deployments, supply a real KMS-backed KmsClient instead.
 */
export class LocalKmsClient implements KmsClient {
	private readonly key: Buffer

	/**
	 * @param keyHex 64-character hex string (32 bytes). Throws when the
	 *   key is missing or the wrong length — fail fast at boot rather than
	 *   on the first credential write.
	 */
	constructor(keyHex: string) {
		const key = Buffer.from(keyHex, 'hex')
		if (key.length !== 32) {
			throw new VaultUnavailableError('VAULT_KEY must be a 64-character hex string (32 bytes)')
		}
		this.key = key
	}

	async encrypt(plaintext: string): Promise<string> {
		const iv = randomBytes(12)
		const cipher = createCipheriv('aes-256-gcm', this.key, iv)
		const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
		const tag = cipher.getAuthTag()
		return `local:${iv.toString('hex')}:${tag.toString('hex')}:${data.toString('hex')}`
	}

	async decrypt(ciphertext: string): Promise<string> {
		const parts = ciphertext.split(':')
		if (parts.length !== 4 || parts[0] !== 'local') {
			throw new VaultUnavailableError('local ciphertext expected (local:iv:tag:data)')
		}
		const [, ivHex, tagHex, dataHex] = parts as [string, string, string, string]
		const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivHex, 'hex'))
		decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
		try {
			return Buffer.concat([
				decipher.update(Buffer.from(dataHex, 'hex')),
				decipher.final(),
			]).toString('utf8')
		} catch {
			throw new VaultUnavailableError('local ciphertext failed authentication')
		}
	}
}

/**
 * Per-provider scoped-credential minter. Each connector adapter installs
 * its own minter at registration time. Vault routes mintScopedCredential
 * to the right minter.
 */
export interface ScopedCredentialMinter {
	readonly provider: ProviderId
	mint(plaintext_long_lived: string, req: MintRequest): Promise<ScopedCredential>
}

// ─────────────────────────────────────────────────────────────────────
// In-memory implementation (tests + reference)
// ─────────────────────────────────────────────────────────────────────

interface KmsCacheEntry {
	plaintext: string
	expires_at_ms: number
}

export interface InMemoryVaultOptions {
	/** TTL for the decrypted-plaintext cache. Defaults to 60 s. */
	readonly decryptCacheTtlMs?: number
}

export class InMemoryVault implements Vault {
	private readonly entries = new Map<string, VaultEntry>()
	private readonly cache = new Map<string, KmsCacheEntry>()
	private readonly minters = new Map<ProviderId, ScopedCredentialMinter>()
	private readonly ttlMs: number

	constructor(
		private readonly kms: KmsClient,
		options: InMemoryVaultOptions = {}
	) {
		this.ttlMs = options.decryptCacheTtlMs ?? 60_000
	}

	registerMinter(m: ScopedCredentialMinter): void {
		this.minters.set(m.provider, m)
	}

	async store(input: Omit<VaultEntry, 'id' | 'rotated_at'>): Promise<VaultEntry> {
		const id = `vault_${input.user_id}_${input.provider}_${Date.now()}`
		const entry: VaultEntry = {
			id,
			rotated_at: new Date().toISOString(),
			...input,
		}
		this.entries.set(this.key(input.user_id, input.provider), entry)
		return entry
	}

	async retrieve(user_id: UserId, provider: ProviderId): Promise<VaultEntry | null> {
		return this.entries.get(this.key(user_id, provider)) ?? null
	}

	async revoke(id: string): Promise<void> {
		for (const [k, v] of this.entries) {
			if (v.id === id) {
				this.entries.delete(k)
				this.cache.delete(k)
				return
			}
		}
	}

	async mintScopedCredential(req: MintRequest): Promise<ScopedCredential> {
		const entry = await this.retrieve(req.user_id, req.provider)
		if (!entry) throw new VaultMintError(req.provider, 'no stored credential')
		const plaintext = await this.decryptCached(this.key(req.user_id, req.provider), entry.ciphertext)
		const minter = this.minters.get(req.provider)
		if (!minter) throw new VaultMintError(req.provider, 'no minter registered for provider')
		return minter.mint(plaintext, req)
	}

	private key(user_id: UserId, provider: ProviderId): string {
		return `${user_id}::${provider}`
	}

	private async decryptCached(key: string, ciphertext: string): Promise<string> {
		const hit = this.cache.get(key)
		const now = Date.now()
		if (hit && hit.expires_at_ms > now) return hit.plaintext
		const plaintext = await this.kms.decrypt(ciphertext)
		this.cache.set(key, { plaintext, expires_at_ms: now + this.ttlMs })
		return plaintext
	}
}
