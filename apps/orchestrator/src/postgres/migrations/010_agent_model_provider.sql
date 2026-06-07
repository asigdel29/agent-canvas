-- Schema v10: per-agent model provider + OpenAI-compatible base URL.
--
-- Agents can now run on either the native Anthropic Messages API or any
-- OpenAI-compatible /chat/completions endpoint. Two columns capture the
-- choice on the existing `agents` table:
--
--   provider         which client the run loop constructs. Defaults to
--                    'anthropic' so every pre-existing row keeps its
--                    current behavior with no backfill.
--
--   model_base_url   the OpenAI-compatible API root (e.g.
--                    'https://api.openai.com/v1') for provider='openai'.
--                    NULL for the native Anthropic provider, which has a
--                    fixed endpoint. The application layer SSRF-checks
--                    this value on write and on use; the column itself
--                    stores the validated string.
--
-- The model id stays an opaque text column: each provider owns its own
-- id namespace, so no CHECK constraint enumerates them here.

ALTER TABLE agents
	ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'anthropic',
	ADD COLUMN IF NOT EXISTS model_base_url text;

-- Guard the small, closed set of providers at the storage layer so a
-- malformed write cannot persist an unroutable value.
ALTER TABLE agents
	DROP CONSTRAINT IF EXISTS agents_provider_check;
ALTER TABLE agents
	ADD CONSTRAINT agents_provider_check
	CHECK (provider IN ('anthropic', 'openai'));
