# @agent-canvas/sdk

TypeScript client for the agent-canvas orchestrator REST API.

## Install

```
npm install @agent-canvas/sdk
```

## Quick start

```ts
import { AgentCanvasClient } from '@agent-canvas/sdk'

const ac = new AgentCanvasClient({
  base_url: 'https://orchestrator.example.com',
  token: process.env.AGENT_CANVAS_TOKEN!, // ack_<43-char-base64url>
})

// List your live tokens.
const tokens = await ac.tokens.list()

// Mint a new one. The raw_token is returned ONCE; persist it.
const issued = await ac.tokens.mint({ name: 'cli', scope: 'read' })
console.log(issued.raw_token)

// Start an agent run.
const run = await ac.runs.start({
  agent_id: 'agt_1',
  room_id: 'room_1',
  initial_message: 'Summarize the spec doc.',
})
```

## Webhook receiver

Verify an inbound webhook with the canonical signing primitive — the
same logic the orchestrator uses on egress.

```ts
import { verifyWebhook, SIGNATURE_HEADER } from '@agent-canvas/sdk'

// Express-shape handler; same idea on any framework.
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const header = req.header(SIGNATURE_HEADER) ?? ''
  const body = req.body.toString('utf8') // raw bytes — do NOT pre-parse
  const r = verifyWebhook({
    secret: process.env.WEBHOOK_SIGNING_SECRET!,
    header,
    body,
  })
  if (!r.ok) {
    return res.status(400).json({ error: r.reason })
  }
  const event = JSON.parse(body)
  // process event ...
  res.status(200).end()
})
```

## Authentication

The SDK takes an API token (prefix `ack_`). Mint one with:

```
curl -X POST https://orchestrator.example.com/api/tokens \
  -H "Authorization: Bearer <session-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"name":"my-cli","scope":"write"}'
```

`scope: 'read'` accepts viewer+ routes. `scope: 'write'` accepts
member+. Tokens carry the workspace id from the issuing session;
they cannot reach other workspaces.

## Error handling

Every method throws `ApiError` on a non-2xx. The error carries
`status`, `code`, `detail`, and (when present) rate-limit headers
so callers can self-pace.

```ts
import { ApiError } from '@agent-canvas/sdk'

try {
  await ac.tokens.mint({ name: 'x', scope: 'read' })
} catch (err) {
  if (err instanceof ApiError && err.status === 429) {
    await sleep(err.rate_limit?.retry_after_sec ?? 60)
  } else {
    throw err
  }
}
```

## What's in this package

- `AgentCanvasClient` — REST client with methods for tokens,
  webhooks, audit, billing, runs.
- `verifyWebhook` — HMAC-SHA256 + timestamp-tolerance check for
  inbound webhook deliveries.
- Type re-exports for the wire shapes those methods produce.

## License

MIT.
