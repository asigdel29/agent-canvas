# Phase 0 — Vercel-native sync backend research

Status: **Research only.** This document chooses between two patterns for per-room real-time fanout on Vercel.

## Problem

The agent canvas is a multiplayer real-time product. Every event the orchestrator writes (a `run_event(progress)`, an `approval_request`, etc.) must reach every connected client of every subscribed room within ~1.5s p99 (system SLO). The reference implementation (tldraw's `apps/dotcom/sync-worker`) uses Cloudflare Durable Objects: each room is a stateful DO that holds a single authoritative socket-fanout point. We're not on Cloudflare. We need a Vercel-native equivalent.

## Two patterns under evaluation

### Pattern A — Postgres LISTEN / NOTIFY, stateless functions

```
WRITE PATH
  orchestrator → INSERT event into event_log (txn) → NOTIFY room_<id>('event')
                                                     (same txn)

READ / FANOUT PATH
  client connects to /api/sync?room=<id>
  → Vercel Function holds the WebSocket OR SSE stream
  → Function runs LISTEN room_<id>
  → on NOTIFY: SELECT new rows from event_log WHERE room_id=$1 AND seq > $last
  → push to client
```

**Pros**
- Stateless functions. No sticky routing; any instance can serve any room.
- One source of truth (Postgres) for both state and broadcast.
- Transactional consistency: NOTIFY fires in the same txn as the write, so subscribers see only committed state.
- Trivial scale-out: add functions, add connections, Postgres handles fanout.
- No per-room infrastructure to provision.

**Cons**
- **Postgres connection per active client** unless an external pool (e.g., PgBouncer in transaction mode does NOT support LISTEN; session mode does, but that wastes pool slots). Concretely: 10k concurrent canvas clients ⇒ 10k Postgres sessions. That breaks Neon's default plan limits hard. Need a custom pooler / dedicated proxy layer.
- LISTEN payloads are limited to 8KB and untyped strings (NOTIFY's payload). Best practice: NOTIFY only the room+seq watermark; the function SELECTs the actual event.
- Long-lived Vercel Functions: Fluid Compute supports streaming but the 300s default execution timeout (per knowledge update) makes connection hangs surface. Need explicit reconnect strategy.
- A function instance dies → its LISTEN sessions vanish → its clients reconnect to another instance → catch-up via `seq > $last` query. Standard, but it's a step.

### Pattern B — Sticky-routed Fluid Compute Functions per room

```
WRITE PATH
  orchestrator → INSERT event into event_log (txn) → outbox row
  outbox worker → HTTP POST /internal/fanout/<room_id> with event payload

READ / FANOUT PATH
  client connects to /api/sync?room=<id>
  → Vercel routes to a sticky function instance for room_id (consistent hash)
  → the instance holds an in-memory subscriber set
  → /internal/fanout receives the event, broadcasts to its subscriber set
```

**Pros**
- No per-client Postgres session. Fanout is pure in-memory.
- Familiar pattern (Cloudflare DO mental model, but on Vercel).
- Clear ownership: "the room lives on instance X."

**Cons**
- **Sticky routing on Vercel Fluid Compute is not first-class.** Vercel's routing layer doesn't expose a "consistent-hash by header" primitive the way Cloudflare DOs do. You'd build it: an external routing layer (e.g., a small Worker in front, or a Redis-backed sticky-route table) maps room_id → instance. Operational complexity.
- Instance death = subscriber set lost; all clients of that room reconnect, re-subscribe, catch up. Equivalent to A but more state lost (in-memory set vs Postgres session).
- The outbox worker becomes another moving piece (poller or LISTEN/NOTIFY-driven).
- Cross-room subscription (run X projects into rooms A, B, C) needs a fanout-from-fanout step: outbox publishes to instance(A), instance(B), instance(C). Routing complexity multiplies.
- Cold-start surface per room (instance spin-up on first connection).

## Recommendation (Phase 0)

**Pattern A — Postgres LISTEN/NOTIFY**, with one explicit operational caveat:

- Use a dedicated session-mode pooler for the LISTEN sessions, separate from the orchestrator's transaction-mode pool. Neon supports this via two connection strings. Budget the LISTEN pool sized to expected concurrent canvas clients × 1.2.
- Cap the LISTEN pool. When the pool is full, the function returns a 503 with a `Retry-After: 5s` to the client. Better to fail fast on a connection limit than silently double-book.
- Add a fast-path: clients pull `seq > $last` from Postgres on (re)connect, then subscribe to LISTEN for live updates. Reconnect storms don't lose state because the pull-then-listen sequence is idempotent.
- Transactional outbox still applies: `room_events` table written in-txn with the run_event, NOTIFY fires from a trigger on insert.

Pattern B is the right choice only at a scale where the Postgres session limit becomes the constraint (10k+ concurrent active rooms). Phase 1 targets a smaller scale; revisit at growth thresholds.

## Open items to validate in Phase 0 prototype

1. **Maximum sustained LISTEN sessions per Neon connection-string instance** (need a real number, not docs).
2. **NOTIFY-to-receive latency p99** on Neon under load.
3. **Reconnect storm behavior:** 1000 clients dropped and reconnecting in 5s. Does the pull-then-listen path scale?
4. **Vercel Function execution-time limit interaction** with long-lived SSE/WS streams. Does the 300s default timeout kick in mid-stream, or only on idle?
5. **Cross-room subscription fanout** under pattern A: when run X writes an event and is subscribed in A, B, C, does the projector write to one events table (with room_id × N rows) or one logical event with multiple room_id targets?

## Decision boundary

Switch to Pattern B if:
- LISTEN session pool exhaustion becomes the bottleneck under realistic Phase 1 load.
- Or NOTIFY-to-receive latency p99 exceeds 200ms under load (eats the 1.5s SLO budget).

Otherwise A is simpler, has fewer moving pieces, and reuses Postgres as the single source of truth.

## Next step

Spin up a Neon free tier + a single Vercel Function that holds N SSE connections + a NOTIFY producer. Measure items 1-4 above. If numbers fit, lock Pattern A and move to Phase 1.
