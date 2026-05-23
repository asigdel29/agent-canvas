import { describe, expect, it } from 'vitest'
import { VaultMintError } from '@agent-canvas/connector-core'
import type { ProviderId, RunId, UserId } from '@agent-canvas/orchestrator-types'
import {
	InMemoryVault,
	type MintRequest,
	type ScopedCredentialMinter,
	StubKmsClient,
} from './vault.js'

const USER: UserId = 'user_anu' as UserId
const RUN: RunId = 'run_a' as RunId
const PROV: ProviderId = 'github'

class TestMinter implements ScopedCredentialMinter {
	readonly provider: ProviderId = 'github'
	calls = 0
	async mint(plaintext: string, req: MintRequest) {
		this.calls += 1
		return {
			access_token: `scoped_for_${req.run_id}_from_${plaintext.slice(0, 4)}`,
			expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
			scope: req.requested_scope,
			principal_label: 'anu@github',
		}
	}
}

describe('InMemoryVault', () => {
	it('stores and retrieves a credential entry', async () => {
		const vault = new InMemoryVault(new StubKmsClient())
		const ciphertext = await new StubKmsClient().encrypt('refresh_token_abc')
		const stored = await vault.store({ user_id: USER, provider: PROV, ciphertext })
		expect(stored.id).toBeTruthy()
		const back = await vault.retrieve(USER, PROV)
		expect(back?.ciphertext).toBe(ciphertext)
	})

	it('returns null when no credential exists', async () => {
		const vault = new InMemoryVault(new StubKmsClient())
		expect(await vault.retrieve(USER, PROV)).toBeNull()
	})

	it('mintScopedCredential routes to the registered minter', async () => {
		const vault = new InMemoryVault(new StubKmsClient())
		const minter = new TestMinter()
		vault.registerMinter(minter)
		const ciphertext = await new StubKmsClient().encrypt('refresh_abc')
		await vault.store({ user_id: USER, provider: PROV, ciphertext })
		const scoped = await vault.mintScopedCredential({
			run_id: RUN,
			user_id: USER,
			provider: PROV,
			requested_scope: 'repo:read',
		})
		expect(scoped.access_token).toContain('scoped_for_run_a')
		expect(minter.calls).toBe(1)
	})

	it('mintScopedCredential throws when no credential is stored', async () => {
		const vault = new InMemoryVault(new StubKmsClient())
		vault.registerMinter(new TestMinter())
		await expect(
			vault.mintScopedCredential({
				run_id: RUN,
				user_id: USER,
				provider: PROV,
				requested_scope: 'repo:read',
			})
		).rejects.toThrow(VaultMintError)
	})

	it('mintScopedCredential throws when no minter is registered', async () => {
		const vault = new InMemoryVault(new StubKmsClient())
		const ciphertext = await new StubKmsClient().encrypt('refresh_abc')
		await vault.store({ user_id: USER, provider: PROV, ciphertext })
		await expect(
			vault.mintScopedCredential({
				run_id: RUN,
				user_id: USER,
				provider: PROV,
				requested_scope: 'repo:read',
			})
		).rejects.toThrow(VaultMintError)
	})

	it('caches the decrypted plaintext: second mint does NOT re-decrypt', async () => {
		let decryptCount = 0
		const kms = new StubKmsClient()
		const wrappedKms = {
			encrypt: kms.encrypt.bind(kms),
			decrypt: async (c: string) => {
				decryptCount += 1
				return kms.decrypt(c)
			},
		}
		const vault = new InMemoryVault(wrappedKms, { decryptCacheTtlMs: 5_000 })
		vault.registerMinter(new TestMinter())
		const ciphertext = await kms.encrypt('refresh_xyz')
		await vault.store({ user_id: USER, provider: PROV, ciphertext })
		await vault.mintScopedCredential({
			run_id: RUN,
			user_id: USER,
			provider: PROV,
			requested_scope: 'a',
		})
		await vault.mintScopedCredential({
			run_id: RUN,
			user_id: USER,
			provider: PROV,
			requested_scope: 'b',
		})
		await vault.mintScopedCredential({
			run_id: RUN,
			user_id: USER,
			provider: PROV,
			requested_scope: 'c',
		})
		expect(decryptCount).toBe(1)
	})

	it('revoke removes the entry and invalidates the cache', async () => {
		const vault = new InMemoryVault(new StubKmsClient())
		const ciphertext = await new StubKmsClient().encrypt('refresh_abc')
		const entry = await vault.store({ user_id: USER, provider: PROV, ciphertext })
		await vault.revoke(entry.id)
		expect(await vault.retrieve(USER, PROV)).toBeNull()
	})
})
