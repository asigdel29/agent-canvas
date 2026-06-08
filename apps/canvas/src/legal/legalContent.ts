/**
 * legalContent — Terms of Service and Privacy Policy as static
 * markdown strings rendered by LegalPage.
 *
 * Why inline instead of fetched files: these are part of the
 * canvas bundle, ship with the deploy, and never need to load
 * from the network. The render path stays offline-safe.
 *
 * These documents are not lawyer-vetted. They are a starting
 * point that covers the basic obligations of a BYOK developer
 * tool: what we collect, what we don't, where data lives, how
 * users delete it. Before going to a public launch this should
 * be reviewed by a lawyer or a template service like Termly /
 * Iubenda.
 * @author asigdel29
 */

export const TERMS_OF_SERVICE = `# Terms of Service

_Last updated: 2026-06-08_

These Terms govern your use of **Agent Canvas** ("the Service"), the
deployment at agents.sigdel.world, operated by asigdel29 ("we", "us").
By using the Service you agree to these Terms. If you disagree, stop
using the Service.

## 1. What the Service is

Agent Canvas is an infinite-canvas workspace for running AI agents
with computer use, browser use, and Model Context Protocol (MCP) tool
servers. The Service runs the agents but does not provide the AI model
itself — you bring your own model key (Anthropic, or any OpenAI-
compatible provider such as OpenAI, Gemini, Groq, OpenRouter, or a
local server).

## 2. Your account

You sign in with GitHub. We store your GitHub user id, login,
email (if your GitHub profile exposes it), and display name. We
do not store your GitHub password or access token beyond the
single OAuth exchange used to identify you.

## 3. Your responsibility for your agents

You are responsible for everything an agent you create does
while operating under your account. This includes:

- API costs billed to your Anthropic / E2B / MCP server accounts
- Content the agent produces or distributes
- Actions the agent takes on third-party services you have
  connected via MCP, browser-use, or computer-use
- Compliance with the terms of service of any third-party
  service the agent interacts with

The Service provides an approval gate on destructive tool calls;
you are responsible for reviewing those approvals before granting
them.

## 4. Acceptable use

You will not use the Service to:

- Violate any law
- Build agents that knowingly produce illegal content (including
  CSAM, terrorist incitement, sanctioned-jurisdiction commerce)
- Attempt to interfere with the Service's operation (denial of
  service, scraping at scale, reverse engineering paid features)
- Misrepresent the Service to your own users (e.g. claim that an
  agent's output is human-authored when it is not)
- Pin your own customers' production traffic without their
  consent or visibility

## 5. Bring-your-own-key

You provide your own credentials for Anthropic, OpenAI-compatible
providers, E2B, and any MCP servers your agents connect to. Your
model API keys are held in your browser's memory only — never
written to disk or browser storage — and sent to our server
on each request via HTTP headers. They are cleared when you reload
or close the tab, and we do not persist them.

If the operator instead supplies a shared key as a server
environment variable (e.g. in the Railway service settings), that
key lives in the server's environment and is the operator's
responsibility to rotate.

## 6. Data we keep

For each authenticated session we record:

- Audit log entries for every command and every tool call
- Run events (status, errors, screenshots from computer-use)
- Approval requests and your decisions on them
- Agent definitions you create

We do not record:

- Your API keys (held in browser memory only, never sent to our database)
- The content of your prompts beyond what is in the audit log

Data lives in Postgres (hosted on Railway) and is encrypted at
rest by the provider.

## 7. Data we share

We do not sell your data. We do not share your data with
advertisers. We use the third-party services listed in our
Privacy Policy to operate the Service; each of those services
has access to the subset of data the integration requires.

## 8. Deletion

To delete your account, contact us. We will soft-delete your
account (the audit log retains the agent ids that reference
you, but you become a tombstone in the users table). Full
hard-delete is available on request per Article 17 of the GDPR.

## 9. Pricing

The Service is currently provided without charge. We reserve
the right to introduce paid tiers in the future with at least
30 days notice. Your bring-your-own-key costs remain yours.

## 10. Disclaimers

The Service is provided as-is. No warranty of uptime,
correctness, or fitness for any particular purpose. We are not
responsible for actions agents you create take on third-party
services.

## 11. Limitation of liability

To the maximum extent permitted by law, our liability for any
claim arising out of the Service is limited to the lesser of
(a) the amount you paid us in the prior twelve months (zero
under current pricing) and (b) US\$100.

## 12. Changes

We may revise these Terms. Material changes will be announced
via the Service or by email to the address on your GitHub
profile. Continued use after a revision means you accept it.

## 13. Contact

Questions: open an issue at github.com/asigdel29/agent-canvas.
`

export const PRIVACY_POLICY = `# Privacy Policy

_Last updated: 2026-06-08_

This policy describes what data **Agent Canvas** ("the Service", the
deployment at agents.sigdel.world) collects, why, and how to delete
it. It applies to any deployment of the open-source code base.

## What we collect

**Identity (when you sign in with GitHub):**

- GitHub user id, login, display name, email (if your GitHub
  profile exposes it)
- The session token we issue to your browser

**Usage:**

- Run events from each agent execution (status, tool calls,
  outputs, screenshots from computer-use)
- Audit log entries for every command + every tool call
- Pending and resolved approval decisions

**Operational:**

- Server logs (timestamps, status codes, latency, errors) from the
  server host (Railway). Error messages are logged server-side and
  not returned to your browser.
- Anonymous funnel events (login_started, agent_created, etc.)
  via PostHog when the canvas is deployed with VITE_POSTHOG_KEY
  set. The distinct id is a per-tab random uuid, not tied to
  your GitHub identity.

## What we do NOT collect

- **Your API keys.** Anthropic, OpenAI-compatible, and E2B
  credentials are held in your browser's memory only — never written
  to disk or browser storage. They are sent to our orchestrator on
  each request via HTTP headers and are never written to our database.
- **Your prompts in clear text.** The audit log records that a
  tool was called and the safety classification, not the
  message content beyond what tool_input dictates.
- **Tracking cookies or third-party advertising pixels.** None
  load on the canvas.

## Where data lives

| Service | What it stores |
|---|---|
| Vercel | Serves the static board (CDN) + its access logs |
| Railway | Runs the server + its platform logs, and hosts the Postgres database |
| Postgres (on Railway) | Persistent records: users, workspaces, agents, audit_log, event_log |
| Your model provider | Your prompts, when an agent run sends them — governed by that provider's API policies (e.g. Anthropic, OpenAI) |
| E2B | Computer-use VM sessions (only when you enable computer_use) |
| Upstash Redis | Single-use SSE token nonces (only when configured; otherwise kept in memory) |
| Sentry | Error reports (only when SENTRY_DSN is configured) |
| PostHog | Funnel events (only when VITE_POSTHOG_KEY is configured) |

Check each provider's own status and policies before relying on
this list for compliance purposes.

## Data flow during agent runs

1. Your browser sends a run request with your model key in a header
2. The server forwards the request to the model provider you chose
   for that agent, with your key
3. The provider returns tool calls; the server dispatches them
4. Tool results stream back to your browser live (SSE)
5. Each step is recorded in the audit log keyed to your user id

Your model key passes through our server on every request but is
not stored there. Your chosen provider sees your prompts per its
own API terms.

## Your rights (GDPR / CCPA)

You can request:

- **Access:** a JSON dump of all rows we hold keyed to your user id
- **Correction:** updates to your display name or email
- **Deletion:** hard delete of your user row + soft delete of
  derivative rows. Audit log entries become tombstones (rows
  retained for compliance, your identifier replaced).
- **Portability:** the same access dump in machine-readable form

Open an issue at github.com/asigdel29/agent-canvas to exercise any
of these. We respond within 30 days. Free of charge.

## Cookies

The Service uses:

- **sessionStorage** for your session JWT and room id. Lives until
  tab close. Not a cookie.
- **In-memory only** for your BYOK model API keys — never written to
  any browser storage; cleared on reload or tab close.
- **localStorage** for the onboarding-completed flag. Persists
  across tabs.

No tracking cookies. No third-party advertising cookies.

## Children

The Service is not directed at children under 13 (under 16 in
the EEA). Do not use the Service if you are under the age above.

## Changes

We may update this policy. The "Last updated" date at the top
will change; material changes will be announced via the Service
or email.

## Contact

Open an issue at github.com/asigdel29/agent-canvas.
`
