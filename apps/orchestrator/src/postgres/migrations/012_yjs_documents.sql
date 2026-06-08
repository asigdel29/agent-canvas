-- Schema v12: yjs_documents.
--
-- Durable storage for the collaborative canvas layout. Each workspace
-- (room) has one Yjs document holding card positions; the realtime
-- WebSocket layer (src/yjs/yjsServer.ts) keeps an in-memory Y.Doc per
-- active room and snapshots its encoded state here, debounced, so a
-- restart or a room going cold and warm again restores the arrangement.
--
-- Only layout lives here. Agent run state continues to flow through the
-- event log + SSE pipeline and is never duplicated into the Yjs doc.
--
--   doc          the full encoded Y.Doc state (Y.encodeStateAsUpdate),
--                stored as bytea. Overwritten wholesale on each save.

CREATE TABLE IF NOT EXISTS yjs_documents (
	workspace_id  text          PRIMARY KEY REFERENCES workspaces (id),
	doc           bytea         NOT NULL,
	updated_at    timestamptz   NOT NULL DEFAULT now()
);
