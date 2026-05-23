/**
 * AWS KMS adapter for Vault.
 *
 * The orchestrator stores long-lived OAuth refresh tokens and webhook
 * secrets encrypted at rest. The encryption key lives in KMS; the
 * orchestrator only ever holds ephemeral plaintext during a single
 * mint/refresh operation.
 *
 * Config: KMS_KEY_ID (the customer-managed key's ARN or alias).
 *   AWS_REGION and credentials follow the AWS SDK default-chain
 *   (env vars, IAM role on Vercel, or shared config).
 *
 * Plaintext caching with a bounded TTL is in InMemoryVault; this
 * adapter just encrypts/decrypts.
 */

import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms'
import { VaultUnavailableError } from '@agent-canvas/connector-core'
import type { KmsClient } from '../orchestration/vault.js'

export interface AwsKmsClientOptions {
	readonly keyId: string
	readonly region?: string
	readonly client?: KMSClient
}

export class AwsKmsClient implements KmsClient {
	private readonly client: KMSClient
	private readonly keyId: string

	constructor(opts: AwsKmsClientOptions) {
		this.keyId = opts.keyId
		this.client =
			opts.client ?? new KMSClient(opts.region ? { region: opts.region } : {})
	}

	async encrypt(plaintext: string): Promise<string> {
		try {
			const result = await this.client.send(
				new EncryptCommand({
					KeyId: this.keyId,
					Plaintext: new TextEncoder().encode(plaintext),
				})
			)
			if (!result.CiphertextBlob) throw new VaultUnavailableError('KMS returned no ciphertext')
			return Buffer.from(result.CiphertextBlob).toString('base64')
		} catch (err) {
			if (err instanceof VaultUnavailableError) throw err
			throw new VaultUnavailableError(
				`KMS Encrypt failed: ${err instanceof Error ? err.message : String(err)}`
			)
		}
	}

	async decrypt(ciphertext: string): Promise<string> {
		let blob: Buffer
		try {
			blob = Buffer.from(ciphertext, 'base64')
		} catch {
			throw new VaultUnavailableError('ciphertext is not valid base64')
		}
		try {
			const result = await this.client.send(
				new DecryptCommand({
					KeyId: this.keyId,
					CiphertextBlob: blob,
				})
			)
			if (!result.Plaintext) throw new VaultUnavailableError('KMS returned no plaintext')
			return new TextDecoder().decode(result.Plaintext)
		} catch (err) {
			if (err instanceof VaultUnavailableError) throw err
			throw new VaultUnavailableError(
				`KMS Decrypt failed: ${err instanceof Error ? err.message : String(err)}`
			)
		}
	}
}
