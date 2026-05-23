import { describe, expect, it, vi } from 'vitest'
import { VaultUnavailableError } from '@agent-canvas/connector-core'
import {
	DecryptCommand,
	EncryptCommand,
	KMSClient,
} from '@aws-sdk/client-kms'
import { AwsKmsClient } from './awsKms.js'

function mockKms(handlers: {
	encrypt?: (input: EncryptCommand) => unknown
	decrypt?: (input: DecryptCommand) => unknown
}): KMSClient {
	const client = new KMSClient({})
	client.send = vi.fn(async (cmd: unknown) => {
		if (cmd instanceof EncryptCommand) {
			if (!handlers.encrypt) throw new Error('encrypt not mocked')
			return handlers.encrypt(cmd)
		}
		if (cmd instanceof DecryptCommand) {
			if (!handlers.decrypt) throw new Error('decrypt not mocked')
			return handlers.decrypt(cmd)
		}
		throw new Error('unexpected KMS command')
	}) as unknown as KMSClient['send']
	return client
}

describe('AwsKmsClient', () => {
	it('encrypts plaintext and base64-encodes the ciphertext', async () => {
		const client = mockKms({
			encrypt: (cmd) => {
				expect(cmd.input.KeyId).toBe('alias/agent-canvas')
				return { CiphertextBlob: new TextEncoder().encode('ciphertext_for_' + new TextDecoder().decode(cmd.input.Plaintext as Uint8Array)) }
			},
		})
		const kms = new AwsKmsClient({ keyId: 'alias/agent-canvas', client })
		const result = await kms.encrypt('refresh_token_abc')
		const decoded = Buffer.from(result, 'base64').toString('utf8')
		expect(decoded).toBe('ciphertext_for_refresh_token_abc')
	})

	it('decrypts base64 ciphertext back to plaintext', async () => {
		const client = mockKms({
			decrypt: (_cmd) => ({ Plaintext: new TextEncoder().encode('refresh_token_abc') }),
		})
		const kms = new AwsKmsClient({ keyId: 'alias/agent-canvas', client })
		const inputCiphertext = Buffer.from('opaque_bytes', 'utf8').toString('base64')
		expect(await kms.decrypt(inputCiphertext)).toBe('refresh_token_abc')
	})

	it('throws VaultUnavailableError when KMS Encrypt returns no ciphertext', async () => {
		const client = mockKms({ encrypt: () => ({}) })
		const kms = new AwsKmsClient({ keyId: 'alias/agent-canvas', client })
		await expect(kms.encrypt('x')).rejects.toBeInstanceOf(VaultUnavailableError)
	})

	it('throws VaultUnavailableError when KMS Decrypt returns no plaintext', async () => {
		const client = mockKms({ decrypt: () => ({}) })
		const kms = new AwsKmsClient({ keyId: 'alias/agent-canvas', client })
		const inputCiphertext = Buffer.from('opaque', 'utf8').toString('base64')
		await expect(kms.decrypt(inputCiphertext)).rejects.toBeInstanceOf(VaultUnavailableError)
	})

	it('wraps unknown errors from the AWS SDK into VaultUnavailableError with a useful message', async () => {
		const client = mockKms({
			encrypt: () => {
				throw new Error('AccessDeniedException: no perms')
			},
		})
		const kms = new AwsKmsClient({ keyId: 'alias/agent-canvas', client })
		await expect(kms.encrypt('x')).rejects.toMatchObject({
			name: 'VaultUnavailableError',
			message: expect.stringContaining('AccessDeniedException'),
		})
	})
})
