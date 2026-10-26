# OpenBox for n8n — Cloud Edition

`n8n-nodes-openbox-hook` — OpenBox governance community node for n8n.

This package provides an **OpenBox: Agent** node that wraps n8n LangChain chat models, memory, and tools with OpenBox governance — policy evaluation, PII redaction, HITL approval, and audit traces — without changing your existing workflow structure.

## What Cloud Edition governs

Cloud Edition governs the agent through the calls the node itself makes, and
nothing else. It installs no process-wide instrumentation: it does not patch
`fetch`, `http`/`https`, `fs`, database client prototypes or Node's module
loader, and it does not read `process.env`. Other workflows on the same n8n
instance are unaffected by it.

| Governed | Event |
|---|---|
| The run itself | `WorkflowStarted`, `WorkflowCompleted` (with output guardrails / redaction) |
| The user prompt | `SignalReceived` |
| Every model call | `LLMStarted` (prompt, PII redaction before the call), `LLMCompleted` (completion, model, token counts) |
| Every tool call | `ToolStarted` (input), `ToolCompleted` (output, status, duration) |
| Chat memory load / save | `ActivityStarted`, `ActivityCompleted` |

Each of these can be allowed, blocked, halted or sent for human approval.

Not captured: the HTTP requests, database queries and file operations a tool
makes *inside* its own execution. Cloud Edition sees the tool's input and
output, not its internals. The Full Edition (0.4.x) captured those too; see the
comparison below.

## Cloud Edition vs Full Edition

The Full Edition is the 0.4.x line of this package, which works on self-hosted
n8n only. The Cloud Edition (0.5.0 and later) is built to be allowed on n8n
Cloud.

| | Full Edition (0.4.x) | Cloud Edition (0.5.0+) |
|---|---|---|
| **Where it runs** | Self-hosted n8n only. n8n Cloud does not allow it. | n8n Cloud and self-hosted n8n. |
| **What it watches** | The agent, plus everything happening underneath it. | Only the agent's own steps. |
| **The user's message** | Checked | Checked |
| **Each AI model call** | Question, answer, model, tokens, plus the raw web request to the AI provider. | Question, answer, model and tokens. No raw web request. |
| **Each tool call** | What went in and what came out, plus everything the tool did inside: web calls and database queries. | What went in and what came out. |
| **Database queries** | Every query is recorded, and one can be blocked on its own. | Not seen. |
| **File reads and writes** | Can be recorded (off by default). | Not seen. |
| **Stopping something** | Before a step, or in the middle of a tool (e.g. one database query). | Before a step starts, or after it finishes. Not in the middle of a tool. |
| **Human approval** | Yes | Yes |
| **Hiding personal data (PII)** | Yes | Yes |
| **Other workflows on the same n8n** | Affected: it changes shared parts of n8n for the whole instance. | Not affected. |
| **Extra settings** | Switches for HTTP, databases and files. | Those switches are gone. |
| **Calls to OpenBox** | More: one per web request or query, on top of the agent's steps. | Fewer: one per agent step. |

In short, the Full Edition sees more, but reaches into the whole n8n process to
do it. The Cloud Edition sees the agent's decisions and the tools' inputs and
outputs, and touches nothing outside its own node.

## Install

In n8n, open **Settings > Community Nodes**, choose **Install**, and enter:

```
n8n-nodes-openbox-hook
```

Restart n8n if prompted.

## Credentials

Create an **OpenBox API** credential in n8n with:

| Field | Required | Description |
|---|---|---|
| **API Base URL** | Yes | OpenBox Core API base URL. Point it at your own deployment if self-hosting. |
| **API Key** | Yes | Your OpenBox API key. Live keys start with `obx_live_`; test keys with `obx_test_`. |
| **Agent DID** | No | Agent decentralised identifier (`did:aip:<uuid>`). Required only for agents with `signing_required = true`. |
| **Agent Private Key** | No | Base64-encoded raw 32-byte Ed25519 seed. Paired with Agent DID for signed requests. |

Get your API key from [dashboard.openbox.ai](https://dashboard.openbox.ai).

## Usage

### Basic setup

1. Add an **OpenBox: Agent** node to your workflow.
2. Connect a **Chat Model** sub-node (e.g. OpenAI Chat Model, Anthropic Chat Model) to the **Chat Model** input.
3. Optionally connect **Memory** (max 1) and any number of **Tool** sub-nodes.
4. Attach your **OpenBox API** credential to the node.

That is the whole required setup — there is no agent name or task queue to fill
in. The node exposes the same inputs and outputs as the standard n8n AI Agent
node, so it is a drop-in replacement.

The agent identity reported to OpenBox is derived from the node itself:

- **agent name** — `n8n.Agent.<Node_Name>`, with spaces replaced by underscores. Renaming the node in the canvas renames the agent in your traces.
- **task queue** — always `n8n`.

### Example workflow

```
[Chat Trigger]
      │
      ▼
[OpenBox: Agent]  ←──  [OpenAI Chat Model]
      │            ←──  [Window Buffer Memory]
      │            ←──  [Calculator Tool]
      ▼
[Set node / downstream steps]
```

When the agent runs, OpenBox evaluates each LLM call and tool invocation
against your configured policies. If a call requires approval (HITL), the node
pauses and polls until a decision is received.

### Fallback model

Enable **Enable Fallback Model** to expose a second **Fallback Model** input.
If the primary chat model fails, the agent retries on the fallback. Both models
are governed identically.

### Options

Standard agent behaviour lives under **Options**: `System Message`,
`Max Iterations`, `Enable Streaming`, `Return Intermediate Steps`,
`On Tool Error`, and `Automatically Passthrough Binary Images`.

### Advanced Governance

Governance behaviour lives in the **Advanced Governance** collection. Defaults
are chosen so the node is useful without configuration.

| Option | Default | Description |
|---|---|---|
| **Governance Events to Send** | all six | Which lifecycle events are evaluated: workflow started/completed, LLM started/completed, tool started/completed. |
| **On API Error** | Fail Open | Whether an unreachable OpenBox API lets the workflow continue ungoverned, or stops it. |
| **Governance Request Timeout (Seconds)** | `30` | HTTP timeout for calls to the OpenBox Core API. |
| **Tools to Exclude From Governance** | *(none)* | Comma-separated tool names whose calls are never governed. |
| **Human-in-the-Loop Approval Enabled** | `true` | Whether the node pauses for approval when a policy demands it. |
| **Approval Poll Interval (Seconds)** | `5` | How often to poll for an approval decision. |
| **Approval Max Wait (Seconds)** | `3600` | How long to wait before halting. `0` waits indefinitely. |

### Advanced: Agent DID signing

For agents configured with `signing_required = true` in OpenBox, fill in the
**Agent DID** and **Agent Private Key** fields in the credential. Every request
to the OpenBox API will be signed with an Ed25519 signature automatically.

## Limitations and known issues

Worth reading before you rely on a trace.

### Governance adds latency

Every event is a round trip to the OpenBox API, awaited before the agent moves
on so ordering is preserved. A run with many tool calls makes proportionally
many calls. If that matters, narrow **Governance Events to Send**.

### If the API is unreachable, events are lost silently

**On API Error** defaults to *Fail Open*: the workflow continues ungoverned and
the events for that run are simply never recorded, with no failure surfaced in
the workflow. Choose *Fail Closed* if a missing audit trail should stop the run.
An invalid API key (401/403) always stops the run, whatever this is set to.

### Approval can only gate work that has not happened yet

`ToolStarted` and `LLMStarted` are evaluated before the call, so `block` or
`require_approval` there prevents it. A verdict on a *completed* event cannot
un-run the work — it stops the agent from continuing, but the call has already
happened. With HITL enabled the node blocks while polling, up to **Approval Max
Wait** (default 3600 s; `0` waits indefinitely).

### Token counts come from the model response

Model name and token counts on `LLMCompleted` are read from the LangChain
response the chat model returns. A provider that does not report usage leaves
them empty.

### Testing locally

`n8n execute` on the CLI **does not support queue mode** and silently falls back
to regular mode, so it cannot reproduce anything specific to a queue-mode
deployment. To exercise a worker, run n8n in queue mode and trigger the workflow
so the main instance enqueues it — a schedule trigger is the simplest way.

### Node identity is tied to the node's name

The agent name is derived as `n8n.Agent.<Node_Name>`. Renaming the node in the
canvas starts reporting under a new agent name, which splits your history.

## Package layout

```text
n8n-nodes-openbox-hook/
  nodes/OpenBoxAgent/
    OpenBoxAgent.node.ts        the OpenBox: Agent node
    openbox.svg, openbox.dark.svg   node icon (light / dark)
  credentials/
    OpenBoxApi.credentials.ts   the OpenBox API credential
  shared/
    openbox-client.ts           signed HTTP client for the Core API
    version.ts                  package version reported to Core
    signing.ts                  Ed25519 request signing
    credential-test.ts          credential connectivity check
    langchain/
      middleware.ts             governance middleware around the agent
      hooks.ts, hook_handlers.ts, tool_hook.ts
      hitl.ts                   human-in-the-loop polling
      verdict.ts, config.ts, client.ts, error-info.ts, types.ts
  tests/                        vitest suites (.mts — see vitest.config.mts)
  scripts/                      build helpers (clean, copy assets)
```

`main` and the `n8n` manifest point into `dist/`, which is built on `prepack`.

## Local development

```bash
npm install
npm run build
npm test
npm run lint                       # n8n Cloud rules, unmodified
npx n8n-node cloud-support         # must report ENABLED
```

To verify the package scan passes once published:

```bash
npx @n8n/scan-community-package n8n-nodes-openbox-hook
```

Release process is documented in [RELEASING.md](RELEASING.md).
