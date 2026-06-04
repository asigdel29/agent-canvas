# Operator guide

Five-minute walkthrough from "I have a Claude key" to "an agent is searching the web for me." If you have not signed in yet, open your deployment's URL first (for a local run, <http://localhost:3000>).

## Time budget

| Step | What | Time |
|---|---|---|
| 1 | Paste your Claude key in Settings | 30s |
| 2 | Create an agent with browser-use enabled | 60s |
| 3 | Hit Run with a real instruction | 5s |
| 4 | Watch events stream into the canvas | rest of the run |
| 5 | (Optional) approve a destructive tool call | 5s per approval |

## 1. Paste your Claude key

Get a key at <https://console.anthropic.com/settings/keys> if you don't have one. The key starts with `sk-ant-`.

In the canvas, click the **gear icon** in the top bar (between the avatar stack and Share). The right rail switches to Settings.

Paste the key into the `Claude API key` field. Click **Save**. The key is stored in your browser's `sessionStorage` only — it never reaches the orchestrator's database, and it vanishes when you close the tab.

If the prefix looks wrong, the field border turns amber and the hint text tells you. Real validity is checked the first time you run an agent.

## 2. Create an agent

In the canvas top-center toolbar, click the **Agent** tool (the small robot face). The New Agent modal opens.

| Field | What to enter |
|---|---|
| Name | `web-research` |
| Purpose | `Search the web and summarize` |
| Model | leave on Sonnet 4.6 |
| System prompt | `You research questions on the web. Use the browser tools. Summarize concisely with citations.` |
| Capabilities → Browser use | toggle on |
| Capabilities → MCP servers | leave empty for now |

Hit **⌘+Enter** or click **Create agent**.

The modal closes. A new shape labelled `web-research` lands on the canvas with a `browser` chip in its capability row.

## 3. Run it

Click the shape on the canvas. The right rail switches to Inspector. You see:

- Agent name, purpose, model
- A textarea labelled `Run instruction`
- A primary **Run agent** button

Type: `What did Anthropic announce this week?`

Click **Run agent** (or hit ⌘+Enter inside the textarea). The button greys out.

## 4. Watch events stream in

The agent shape's border turns **live-pink** while running, with a pulsing status dot.

The right rail's Activity feed shows live events:

```
●  run_xyz   browser    progress
●  run_xyz   browser    tool_call  (browser__navigate)
●  run_xyz   browser    tool_result (status 200)
●  run_xyz   browser    progress
●  run_xyz   browser    tool_call  (browser__get_text)
...
●  run_xyz   browser    succeeded
```

Each `tool_call` event surfaces the tool name + a preview of the input; each `tool_result` shows whether it succeeded and a preview of the output. The right-rail Inspector shows the same feed scoped to this run.

When the model finishes, the shape's border returns to neutral and the final text appears in the Activity feed as a `progress` event.

## 5. Approve a destructive tool (only when wired to MCP)

Browser-use tools are classified `safe` — they run without approval. MCP server tools default to `destructive` when the server is marked `untrusted` (the default for any MCP server you add).

When the model calls a destructive tool, the run pauses. An approval card appears in the right rail's Activity section:

```
+----------------------------------------+
|  web-research                    just now |
+----------------------------------------+
|  github.create_issue                    |
|  · destructive                          |
|                                         |
|  Open a GitHub issue with title         |
|  "Bug: search returns empty…"           |
|                                         |
|  [ Reject ]              [ Approve ]    |
+----------------------------------------+
```

Click **Approve** to let the tool run, **Reject** to feed the model a rejection so it can recover with a different plan. The card disappears on either action; the agent continues immediately.

If you don't decide within 15 minutes, the orchestrator treats the approval as rejected so the model gets a definite "no" rather than hanging.

## What can go wrong

| Symptom | What's happening | Fix |
|---|---|---|
| **"No Claude API key is set"** toast | The orchestrator received no `x-anthropic-api-key` header and has no env fallback. | Click **Open Settings →** on the toast, paste a valid key, Save. |
| **"Computer-use is disabled"** toast | An agent has `computer_use` enabled but the orchestrator can't reach E2B (no `E2B_API_KEY`). | Open Settings, paste your E2B key. Or remove computer-use from the agent. |
| **"An MCP server failed to connect"** toast | One of the agent's MCP server URLs refused the connection. | Check the server URL in the agent's config. Other capabilities still work. |
| **"Live feed disconnected"** banner | The SSE client gave up after 20 reconnect attempts (~9 minutes of network failure). | Click **Reload to reconnect** in the banner. Your canvas state is preserved. |

## Adding an MCP server

Public MCP servers exist for GitHub, Linear, Notion, Slack, Postgres, and more. The MCP registry at <https://github.com/modelcontextprotocol/servers> lists official ones.

In the New Agent modal, scroll to the MCP servers section and click **+ Add server**. Enter:

- `id`: a short label you'll see on the agent shape (e.g. `gh`)
- `url`: the SSE endpoint of the MCP server (e.g. `https://your-host/mcp/sse`)
- `trust`: leave on `untrusted` for any server you don't host yourself

After Save, the agent has all of that server's tools available, namespaced `mcp__<id>__<tool_name>`. Untrusted tools require your approval per call (see step 5).

## Capabilities cheat sheet

| Capability | When to use | What it gives Claude |
|---|---|---|
| Browser use | Public web research, scraping, form-fill | 10 tools: navigate, click, type, screenshot, get_text, get_links, back, press_key, wait_for, current_url |
| Computer use | Anything that needs OS-level access | One `computer` tool with screenshot + mouse + keyboard primitives, on an E2B sandboxed Linux desktop |
| MCP servers | Anything specific to a third-party service | Every tool that server exposes, namespaced and trust-gated |

Combine all three on a single agent: an MCP server can post to Linear, a browser tool can read public docs, computer-use can drive a desktop app. The model sees all three as one tool catalog.

## Where things live in the UI

- **Top bar** — workspace name, presence, spend, settings (⚙), share
- **Left rail** — workflows (your agents) + recent runs + configured connectors
- **Canvas** — agent shapes, capability chips, live-pink border on running agents, screenshot thumbnails for computer-use
- **Right rail** — three modes: Inspector (when an agent is selected) / Activity (live event feed + approvals) / Settings (your BYOK fields)
- **Floating toolbar** (top-center) — Hand, Select, **Agent** (create), Connector, Comment
- **Zoom cluster** (bottom-right) — zoom in/out, fit, density toggle

## Keyboard shortcuts

| Key | Action |
|---|---|
| `H` | Hand tool |
| `V` | Select tool |
| `A` | Open New Agent modal |
| `C` | (reserved) Connector tool |
| `/` | (reserved) Comment tool |
| `⌘ +` / `⌘ -` | Zoom |
| `⇧ 1` | Fit to screen |
| `D` | Toggle density (collapse far-away shapes) |
| `Esc` | Close any modal |
| `⌘ Enter` | Submit New Agent modal / Run instruction in Inspector |

## Cleaning up

Open the Settings drawer at any time and clear both fields, then Save. The keys are removed from `sessionStorage`. Closing the tab does the same thing — `sessionStorage` is per-tab.

To delete an agent: select it on the canvas, hit Delete. The agent is soft-deleted on the orchestrator (audit log keeps the trail forever); the shape disappears from your canvas.

To sign out: clear the browser tab's session storage or wait 7 days for the session JWT to expire. (A first-class Sign out button is on the roadmap.)
