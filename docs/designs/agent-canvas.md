# Agent canvas — design doc

Status: **Active. Phase 0 / Phase 1 scaffolding in progress.**
Date: 2026-05-23
Plan reviews completed: CEO (CLEAR), Design (CLEAR 3/10 → 9/10), Eng (CLEAR), 2× outside-voice passes.
Source-of-truth commits referenced: tldraw `84056a8f8`.

## Vision

A multiplayer infinite-canvas workspace where humans and many long-running cloud AI agents share one spatial surface. Agents render as event-graph nodes; their tool calls, progress events, and approval requests stream onto the canvas as connected child nodes; teammates watch and steer in real time. Eight connectors (GitHub, Linear, Slack, Discord, Graphite, Railway, Vercel, Supabase) plus two managed agent vendors plug in behind one Connector interface.

## Goals

- Spatial, multiplayer-native UX for supervising multiple long-running agents at once.
- Backend-authoritative correctness: agent runs are event-sourced in Postgres, canvas is a projection.
- Approval gates on destructive actions; vault-isolated short-lived scoped credentials.
- Phase 1 ships an end-to-end vertical slice with one agent vendor live and three connectors (GitHub, Linear, Slack), behind a strict Connector interface that scales to all ten.

## Non-goals

- Not a fork of tldraw. Depends on `@tldraw/tldraw` + `@tldraw/sync` via npm.
- Not owning the agent loop. Managed agent vendors (OpenHands / Codex) run the agent; this product orchestrates, observes, and collaborates.
- Not mid-run vendor failover. Runs are sticky to their start-time vendor.
- Not Cloudflare. The existing `apps/dotcom/sync-worker` in the tldraw repo is a *reference* only; this product runs all-Vercel.
- Not building the sync protocol from scratch. Uses `@tldraw/sync` + `@tldraw/sync-core` as the protocol library, with a Vercel-native backend implementation.

## Roadmap

### Phase 0 — prototypes (validate the load-bearing hypotheses)

- **Density-adaptive event-graph collapse readability.** Mockup or live prototype renders N=1..10 concurrent agents at default zoom. Validates the rule: if >3 agents fit in the visible viewport at current zoom, all auto-compact; click-to-expand overrides one. If unreadable, fall back to "minimal node + side panel" UX.
- **Vercel-native sync backend pattern.** Research + throwaway prototype comparing Postgres `LISTEN/NOTIFY` for per-room fanout vs sticky-routed Fluid Compute Functions. Decides which goes into Phase 1.

### Phase 1 — vertical slice

- `packages/orchestrator-types` (zero-runtime types).
- `packages/connector-core` (Connector interface, OAuth, webhooks, ProviderAdapter, safety, errors, conformance suite).
- `apps/orchestrator` (Vercel-deployed backend: command endpoint, event log, projector, reconciler, vault, billing gate, input sanitizer).
- Vercel-native sync backend.
- Canvas app on `@tldraw/tldraw` with `AgentShapeUtil` (event-graph + compact-on-zoom-out).
- 3 connector adapters (GitHub + Linear + Slack) + 1 agent vendor (Codex or OpenHands).
- Approval inbox UI, reconnect cards, spend gate, audit log.
- E2E cross-stack test as the release gate.
- 5 dashboards + 7 alerts + runbooks.
- Adversarial eval suite (≥100 injection fixtures, baselines, 2-reviewer baseline-update rule).

### Phase 2 — completeness

- Remaining 5 connectors (Discord, Graphite, Railway, Vercel-as-connector, Supabase).
- Second agent vendor live.
- Cross-room run subscription with per-subscription delegated capability.
- Auto-archive heuristic for old terminated runs.
- Light theme; per-room theme overrides.
- Mobile "take action" UX (Phase 1 is watch-only).
- Defensibility moat: agent memory, templates, multi-agent orchestration patterns.

## Architecture

```
                         ┌────────────────────────────────────────┐
                         │           CANVAS APP (tldraw)           │
                         │   AgentShape (display) · presence · UI  │
                         └───────────────┬────────────────────────┘
                                         │  tldraw sync (projection records only)
                         ┌───────────────▼────────────────────────┐
                         │   SYNC LAYER  (Vercel-native, new)      │
                         │   @tldraw/sync-core protocol            │
                         │   + Vercel Functions per-room sticky    │
                         │   + Neon Postgres + LISTEN/NOTIFY        │
                         └────────────────▲───────────────────────┘
                                          │  PROJECTOR (one-way, idempotent)
        ┌─────────────────────────────────┴──────────────────────────┐
        │            AGENT ORCHESTRATION SERVICE  (AUTHORITY)         │
        │                  apps/orchestrator (Vercel)                 │
        │  ┌─────────────────┐  ┌─────────────┐  ┌──────────────────┐ │
        │  │ Run state mach. │  │ Event log   │  │ Command endpoint │ │
        │  │ (Postgres)      │──│ (append PG  │◀─│ (authz gate)     │ │
        │  └─────┬───────────┘  │  + Blob)    │  └─────────▲────────┘ │
        │        │              └─────┬───────┘            │          │
        │        │                    │                    │ commands │
        │  ┌─────▼──────┐  ┌──────────▼──────────┐         │          │
        │  │ Reconciler │  │ ConnectorRegistry   │         │          │
        │  └─────┬──────┘  └──────────┬──────────┘         │          │
        │        │                    │                    │          │
        │  ┌─────▼──────┐    ┌────────▼──────────┐         │          │
        │  │ Vault      │    │ Adapters (×10)     │         │          │
        │  │ KMS-encr   │    │  GitHub Linear     │         │          │
        │  │ scoped     │    │  Slack Discord     │         │          │
        │  │ per-run    │    │  Graphite Railway  │         │          │
        │  └────────────┘    │  Vercel Supabase   │         │          │
        │                    │  + Codex OpenHands │         │          │
        │                    └─────────▲──────────┘         │          │
        └──────────────────────────────┼─────────────────────┼──────────┘
                                       │ webhooks            │ canvas
                                       │ (Vercel route)      │ commands
                                       │                     │ (delta read)
                              ┌────────▼──────────┐         │
                              │  Vercel Queues    │  ◀──────┘
                              │  (durable, at-    │
                              │  least-once)      │
                              └───────────────────┘
```

All on Vercel: orchestrator (Fluid Compute), webhook ingestion (route handlers), queues (Vercel Queues), Postgres (Marketplace Neon), blob (Vercel Blob), KMS (external — AWS KMS).

### Run state machine

```
   queued ──▶ provisioning ──▶ running ──┬──▶ succeeded
                  │              │  ▲    │
                  │              ▼  │    │
                  │       awaiting_input ┤
                  ▼              │       ▼
               failed ◀──────────┴────▶ cancelled

   Terminal states: succeeded · failed · cancelled · unreachable
   Invalid transitions are rejected by the state machine, never papered
   over by callers (e.g., succeeded → running is rejected).
```

### Start-a-run data flow (happy path + shadow paths)

```
  USER click "start" on AgentShape
        │
        ▼
  canvas writes start_request command (idempotency_key = shape_id + nonce)
        │
        ▼
  command endpoint reads delta  ◀── shadow: orchestrator offline → reconciler catches up
        │
        ▼
  authz: run-agents capability? required connectors present? token fresh?
        │
        ├── FAIL ──▶ rejected_command event → canvas error badge ─▶ done
        ▼
  vault mints short-lived scoped creds (per-run)
        │
        ▼
  AgentProvider.startRun(creds, taskSpec, vendor)
        │
        ├── timeout / 5xx ── bounded retry+backoff ── failed ── run_event(failed)
        ▼
  run_event(provisioning, {vendor}) → run_event(running)
        │
        ▼
  agent runs in vendor cloud  ◀── shadow: vendor drops run silently
        │                                            │
        │                                            ▼
        │                                     reconciler polls vendor;
        │                                     per-run deadline + missing
        │                                     status → run_event(unreachable)
        ▼
  webhook arrives ─▶ Vercel route verifies sig ─▶ per-provider dedupe ─▶ Vercel Queue ─▶ async worker folds
        │
        └─▶ run_event(progress | awaiting_input | succeeded | failed)
                │                       │
                ▼                       ▼
        destructive proposed?     token expired?
                │                       │
                ▼                       ▼
        approval-card event       pause_for_reauth event
                                  (run → awaiting_input)
```

## Locked decisions

### CEO scope review (HOLD mode, all decisions locked)

1. **Backend-authoritative**, canvas-as-projection. The orchestrator (Vercel + Postgres) is the source of truth for run state. The tldraw canvas displays a projection.
2. **Append-only events in Postgres**, canvas holds a projected display window. Status is derived by folding events with `last_seq` monotonicity.
3. **Delegate execution** to a managed agent vendor (Codex or OpenHands). This product never runs an agent loop itself.
4. **Webhook ingest:** Vercel route handler verifies signature → per-provider idempotency derivation → Vercel Queues → async worker folds.
5. **Active reconciliation:** scheduled poll + per-run wall-clock deadline. Missing or blown → `run_event(unreachable)` + alert.
6. **Token expiry mid-run:** run enters `awaiting_input`; canvas surfaces reconnect card; on reconnect, run resumes.
7. **Owned KMS vault** (AWS KMS or equivalent). Per run, mint the narrowest, shortest-lived credential the provider supports (GitHub App installation tokens scoped to specific installations, ~1hr). Long-lived tokens never leave the platform.
8. **Per-member run-agents capability**, separate from edit. Default: editors cannot run agents unless explicitly granted.
9. **Approval gate** on destructive/irreversible actions. Each ToolDescriptor declares safety: `safe | destructive | irreversible`. Safe auto-runs; destructive/irreversible pause + surface approval card.
10. **Orphan handling:** shape deletion writes `cancel_request` command; backend calls vendor cancel API. Cancel-fail → `orphaned-cancel-failed` state surfaces in admin view.
11. **Repo layout:** `packages/connector-core` (publishable framework) + `packages/orchestrator-types` (extracted day-one) + `apps/orchestrator` (with `src/orchestration/*` runtime + `src/connectors/*` adapters).
12. **E2E cross-stack test** is the Phase 1 release gate. One Playwright test driving canvas → command endpoint → mocked AgentProvider → mocked webhook → projector → canvas, asserting run reaches `succeeded`.
13. **Run event log size:** hard cap with truncation; mandatory `status_checkpoint` event written before any truncation to preserve fold correctness.
14. **Durable per-run audit log** (Postgres + Vercel Blob). Retention 90d hot / 1y cold. After canvas truncation, audit log is the only complete record.
15. **Stateless workers + idempotency everywhere.** N instances run safely; deploy windows are non-events.
16. **Vendor strategy:** two managed vendors live at start-time selection (sticky per run; no mid-run failover). Per-run vendor death is a visible run failure with a restart-on-other-vendor offer.
17. **Visualization:** event-graph nodes (each tool_call / progress / approval_request is a small spatial node connected to the parent run) with density-adaptive collapse.
18. **Cost / billing gate:** per-project compute budget; run-starts blocked when budget reached; per-run-per-vendor accounting in the audit log; user-visible spend dashboard.
19. **Input-side prompt-injection defense:** all untrusted text (ticket bodies, issue bodies, webhook payloads, Slack/Discord content) wrapped in structured "UNTRUSTED INPUT" fences before reaching the agent; sanitizer strips known injection patterns; eval suite covers adversarial inputs.
20. **Cross-room run subscriptions** in Phase 1 (CEO review folded the Phase-2 candidate into Phase 1).

### Design review (3/10 → 9/10)

21. **Visual hierarchy on default canvas:** 1st = active agent's parent node, 2nd = approval inbox stack (top-right, count badge, expandable, paginated), 3rd = connector tile strip (top-left), 4th = spend banner (bottom-right). Tool palette + presence are tldraw defaults.
22. **First-run empty state (E1):** centered "Connect a tool to start" + 4 large tiles (GitHub, Linear, Slack, Vercel). Subtitle: "You can add more after."
23. **First tool_call moment:** smooth per-user camera-pan to the new event-node (only on the FIRST tool_call of a run, never subsequent). Reduced-motion respected.
24. **Onboarding micro-copy locks:** OAuth handover is tldraw-internal page with explicit scope list + trust line; just-connected tooltip "Great, now drag an Agent"; agent input rotating-placeholder examples.
25. **Typography:** Switzer (display + UI) + IBM Plex Mono (code/labels). Self-hosted woff2. NEVER load from Google Fonts.
26. **Accent:** graphite (#374151) only. No chromatic accent. Active state = 2px graphite outline + soft-shadow elevation, not color. Status colors stay functional (green / amber / red / zinc).
27. **App-UI classifier explicit:** marketing/landing-page rules do NOT apply. Calm surface hierarchy, dense but readable, utility copy, minimal chrome, cards only when the card IS the interaction.
28. **AI slop blacklist enforced:** no purple/violet gradients, no 3-column feature grids, no icons-in-colored-circles, no centered text-align everywhere, no uniform bubbly radius (radius scale: 4 / 8 / 12 max), no decorative blobs, no emoji as design, no colored left-border cards, no system-ui as primary font.
28b. **Color tokens:** surface `#FAFAFA`, surface-elev `#FFFFFF`, border-hairline zinc-200 `#E4E4E7`, text-strong zinc-900 `#18181B`, text-muted zinc-500 `#71717A`, status-succ emerald-600, status-await amber-500, status-fail red-600, status-unreach zinc-500.
29. **Spacing scale:** 4 / 8 / 12 / 16 / 24 / 32 / 48 (linear, no Fibonacci).
30. **Motion:** `cubic-bezier(0.2, 0, 0, 1)`; durations 150ms chip/state, 300ms card slide, 600ms camera pan. `prefers-reduced-motion` respected.
31. **Density:** body ≥14px, hairlines ≥13px, body contrast minimum 4.5:1 (WCAG AA).
32. **Mobile Phase 1 = watch-only.** Compact card list, no event-graph, taps to approve route to "Open on desktop to act."
33. **A11y:** keyboard cycle Tab agents → inbox → connectors → spend; Space/Enter opens active approval; A/R approve/reject; tldraw shortcuts preserved. ARIA roles: agent `role="article"`, events `role="listitem"`, inbox `role="region"`. Status uses color + icon + shape (never color alone).
34. **Density-adaptive collapse:** if >3 agents visible in viewport at current zoom, all auto-compact. Click compact card to force-expand one (others stay compact). Density recompute on pan/zoom/resize is a cheap bbox count, not a layout pass.
35. **Cross-room run visualization:** visually identical to local runs + small "from [Room]" chip in header. Interactions follow the per-subscription capability set.
36. **Terminal residue:** terminal runs collapse to summary cards and stay on canvas indefinitely; user manually archives; bulk sweep available; archived runs leave the canvas but remain in the audit log.

### Eng review

37. **Deploy target:** all-Vercel. Orchestrator + ingestion + sync + vault all on Vercel. The existing `apps/dotcom/sync-worker` (Cloudflare DOs) is a reference, not a reuse target.
38. **Cross-room subscription authz:** per-subscription delegated capability with explicit allowed-actions allowlist and `subscription_epoch` TOCTOU guard. Establishing requires `run-agents` in BOTH origin and target; audited with `established_by_user_id` + `subscription_id`; origin-revocable. New target-room members get NO inherited write authority on existing subscriptions.
39. **Vendor capability:** live `vendor.getSupportedTools()` cached with TTL + webhook-invalidated, replacing static `supportedVendors[]`. Each `ToolDescriptor` reports its required tool ID set; orchestrator filters vendors at run-start; `NoCompatibleVendorError` if intersection is empty. Vendor pinned at start, captured in `run_event(provisioning, {vendor, capability_snapshot_hash})`.
40. **Package boundary:** `packages/connector-core` holds connector interface + OAuth + webhook + ProviderAdapter + per-module errors. `packages/orchestrator-types` (extracted day-one) holds Run state machine types, event log types, projector contracts, command types, pure fold helpers (zero runtime). `apps/orchestrator/src/orchestration/*` holds runtime implementations.
41. **Eval suite:** `apps/orchestrator/evals/taskspec/{happy,injection,oversize,multilingual,encoding,empty,quality}/`. Minimum per-category (injection ≥100). Baselines at `evals/taskspec/baselines/v1.json`. CI: nightly + on every diff to `taskSpec.ts` or transitive prompt-graph imports. Safety-category failure blocks merge; quality regression >X% blocks merge. Baseline updates require 2-reviewer sign-off. Per-PR + daily cost ceiling. Rule-judged, not LLM-judged.
42. **`run_current_state` cache:** denormalized Postgres row updated in the SAME transaction as every event_log append. `UPDATE ... WHERE run_id = $1 AND last_seq < $2` monotonicity predicate. Columns: `run_id PK, status, vendor, last_seq, last_event_at, schema_version, updated_at`. Reads are O(1). Transactional outbox pattern for broadcast consistency (PG write → outbox table → sync push).

### Folded engineering rules (no separate decisions, mandatory)

- **Single error source of truth** per module in `packages/connector-core/src/errors/{vendor,webhook,oauth,vault}.ts`. No ad-hoc `new Error("...")` for typed conditions.
- **Naming convention:** `XxxShapeUtil` (extends tldraw `ShapeUtil`). Record types living in tlschema get `TL`-prefix (`TLRun`, `TLRunEvent`). Internal orchestrator types have no prefix.
- **API reports** for every package via api-extractor (matches tldraw repo pattern). `npm run api-check` must pass.
- **Adapter conformance suite** in `packages/connector-core/src/conformance.ts`. Every adapter imports and runs it. Mechanically prevents drift.
- **`ConnectorRegistry` singleton** owns all adapters. New connector = new file + one `register()` call.
- **W3C `traceparent` propagated at every async boundary** (queue message envelope, HTTP push, Postgres event_log row, RPC). Single log aggregator (Axiom / Datadog / Logflare).
- **KMS read caching with bounded TTL.** Alert if mint QPS exceeds budget.
- **Transactional outbox for broadcast.** Outbox table polled or LISTEN/NOTIFY'd; broadcast reads from `run_current_state` AFTER commit; never from in-memory event projection.
- **No transitive cross-room subscriptions** in Phase 1.
- **Vendor health-check / circuit-breaker** ties into the run-start candidate filter (a vendor currently 5xx-ing is excluded).
- **No mid-run tool additions** to a running TaskSpec.

## Authz model

```
CAPABILITY (per user × per room)              | GRANTS
----------------------------------------------|----------------------------------------------
view                                          | observe canvas, see agent nodes
edit                                          | + create/move/delete non-agent shapes
run-agents                                    | + start runs in this room
                                              | + (in BOTH origin AND target) establish a cross-room subscription
                                              | + revoke subscriptions you established
subscriber-actor                              | act on subscribed runs in this room
                                              | (action allowlist enforced per-subscription)
admin                                         | + edit any subscription, view audit log

EVERY destructive/irreversible action ALSO requires approval-gate satisfaction
EVERY action writes an audit entry with: actor, room_id, run_id, action, command, result,
                                          subscription_id?, established_by?, ts
```

## Failure modes registry

```
CODEPATH                              | FAILURE                  | RESCUED | TESTED | USER SEES                  | LOGGED
--------------------------------------|--------------------------|---------|--------|----------------------------|-------
Vercel sync backend                   | per-room state loss      | YES     | YES E2E| "syncing..."               | YES
Postgres LISTEN/NOTIFY (or sticky)    | fanout missed            | YES     | YES    | brief lag, auto-recover    | YES
Vault (external KMS)                  | KMS unavailable          | YES     | YES    | "run won't start"          | YES P0
Vault                                 | thundering-herd KMS QPS  | YES     | YES    | brief delay; bounded queue | YES alert
Transactional outbox                  | broadcast inconsistency  | YES     | YES    | brief lag                  | YES
run_current_state (denorm row)        | lock contention spike    | YES     | YES LD | tail-latency spike         | YES alert
run_current_state                     | stale apply (out-of-ord) | YES     | YES    | nothing (monotonicity gate)| YES
Per-subscription authz                | TOCTOU revoke race       | YES     | YES    | "permission revoked"       | YES
Vendor capability rot                 | tool no longer supported | YES     | YES    | NoCompatibleVendorError    | YES
Webhook ingest                        | forged signature         | YES     | YES    | nothing (401)              | YES
Webhook ingest                        | replay 10x               | YES     | YES    | nothing                    | YES
Eval baseline                         | silent safety regression | YES     | YES    | n/a (CI blocks merge)      | YES
AgentProvider.startRun                | vendor 5xx persistent    | YES     | YES    | failed card + restart     | YES
AgentProvider                         | run silently dies        | YES     | YES    | "unreachable" badge        | YES
Connector OAuth                       | refresh fails / revoked  | YES     | YES    | reconnect card             | YES
Cost gate                             | budget exhausted         | YES     | YES    | "budget reached"           | YES
Input sanitizer                       | injection detected       | YES     | YES    | sanitized + flagged        | YES
```

Zero critical gaps (every row has rescue + test + user-visible signal + log).

## Observability + SLOs

- **Webhook-receipt → canvas-visible: ≤ 1.5s p99** (intra-cloud, all-Vercel).
- **Reconciler unreachable-detect rate alert** if > 5% of runs.
- **Vendor error rate alert** if > 2%.
- **Webhook lag p99 alert** if > 30s.
- **Queue backlog alert** if depth > 1000.
- **Token refresh failure spike alert.**
- **Vault mint failure alert.**
- **Scheduler dead alert (P0).**
- **6 day-1 dashboards:** run lifecycle, vendor health (per vendor), webhook flow, connector health, approval gate flow, spend by project.

## Testing strategy

- **Unit:** vitest, alongside source as `*.test.ts`.
- **Integration:** per-package; mocks managed at the package boundary.
- **E2E:** Playwright; one cross-stack test (canvas → command endpoint → mock vendor → mock webhook → projector → canvas) is the Phase 1 release gate.
- **Adversarial test set:** forged webhook, prompt-injection ticket, replay storm, vendor malformed JSON, reconnect-regression attempt (must be impossible under backend-authoritative).
- **Adversarial eval suite:** ≥100 fixtures in `injection` category alone; baselines committed and diffed in CI.
- **Adapter conformance suite:** every adapter imports and runs the framework conformance fixture. Drift = test failure.
- **Test plan artifact:** the engineering-review test plan is the QA source-of-truth.

## Worktree parallelization

| Step | Module                                       | Depends on |
|------|----------------------------------------------|------------|
| F    | `packages/orchestrator-types`                 | —          |
| B    | `packages/connector-core`                     | —          |
| C    | `apps/orchestrator/src/orchestration`         | F          |
| A    | Canvas app (`@tldraw/tldraw` consumer)        | F          |
| E    | `apps/orchestrator/evals`                     | F          |
| D    | `apps/orchestrator/src/connectors/*`          | B, C       |

Lanes: (1) F + B parallel · (2) C + A + E parallel · (3) D in 10 sub-lanes (one per adapter).

## Open questions / Phase 2

- Cross-room run UX (approval routing across many rooms) at scale.
- Auto-archive heuristic for old terminated runs.
- Defensibility moat: agent memory, templates, multi-agent orchestration patterns.
- Mobile take-action UX.
- Pricing model.
- Light theme.

## Source documents

- Engineering-review test plan — the QA source-of-truth for this design.
- Design review log: CEO, design, and engineering plan reviews.
