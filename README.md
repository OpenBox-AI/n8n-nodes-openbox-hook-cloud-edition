# OpenBox for n8n — Cloud Edition

[![npm](https://img.shields.io/npm/v/n8n-nodes-openbox-hook)](https://www.npmjs.com/package/n8n-nodes-openbox-hook)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Governance for n8n AI agents. This package adds an **OpenBox: Agent** node, a
drop-in replacement for n8n's AI Agent node, that checks every step of the
agent against your OpenBox policies before and after it runs:

- **Block** a prompt, model call or tool call that breaks a policy.
- **Pause for human approval** and carry on once someone approves it in OpenBox.
- **Redact personal data** (PII) before it reaches the model or leaves the agent.
- **Record an audit trail** of every run, model call and tool call.

It runs on **n8n Cloud** and on **self-hosted n8n**, and touches nothing outside
its own node: other workflows on the same instance are unaffected.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Credentials](#credentials)
- [What is governed](#what-is-governed)
- [Node settings](#node-settings)
- [Signed and workload-identity agents](#signed-and-workload-identity-agents)
- [Limitations](#limitations)
- [What makes it the Cloud Edition](#what-makes-it-the-cloud-edition)
- [Development](#development)

## Install

**n8n Cloud and self-hosted (UI):** open **Settings > Community Nodes**, choose
**Install**, and enter:

```
n8n-nodes-openbox-hook
```

Restart n8n if prompted.

**Self-hosted (manual):** install the package into n8n's nodes folder and
restart n8n:

```bash
mkdir -p ~/.n8n/nodes && cd ~/.n8n/nodes
npm install n8n-nodes-openbox-hook
```

## Quick start

1. In OpenBox, create an agent and copy its API key
   ([dashboard.openbox.ai](https://dashboard.openbox.ai)).
2. In n8n, create an **OpenBox API** credential with that key (see
   [Credentials](#credentials)).
3. Add an **OpenBox: Agent** node to your workflow and attach the credential.
4. Connect a **Chat Model** sub-node (e.g. OpenAI Chat Model, Anthropic Chat
   Model). Optionally connect one **Memory** and any number of **Tool**
   sub-nodes.

That is the whole setup. There is no agent name or task queue to fill in, and
the node has the same inputs and outputs as n8n's AI Agent node, so you can
swap it into an existing workflow.

```
[Chat Trigger]
      │
      ▼
[OpenBox: Agent]  ←──  [OpenAI Chat Model]
      │            ←──  [Window Buffer Memory]
      │            ←──  [Calculator Tool]
      ▼
[Downstream steps]
```

The agent is reported to OpenBox as `n8n.Agent.<Node_Name>` (spaces become
underscores), on task queue `n8n`.

## Credentials

Create an **OpenBox API** credential with:

| Field | Required | Description |
|---|---|---|
| **API Base URL** | Yes | OpenBox Core URL. Defaults to `https://core.openbox.ai`; change it only for your own deployment. |
| **API Key** | Yes | The agent's API key. Live keys start with `obx_live_`, test keys with `obx_test_`. |
| **Agent DID** | No | `did:aip:<uuid>`. Only for agents with signing required. |
| **Agent Private Key** | No | Base64 raw 32-byte Ed25519 seed, paired with Agent DID. |
| **Workload Private Key** | No | PKCS8 PEM RSA key of the agent's workload identity (IAM v3). |

Which fields you fill depends on how the agent was set up in OpenBox:

| Agent type | Fill in |
|---|---|
| Standard agent | API Base URL, API Key |
| Agent with signing required | + Agent DID, Agent Private Key |
| Agent with workload identity (organisation has an identity provider) | + Workload Private Key; leave Agent DID and Agent Private Key empty |

The credential's **Test** button checks the key (and, for workload identity,
that a token can be obtained) without sending any governance event.

## What is governed

The node governs the agent through the calls it makes itself, and nothing else:

| Step | Events |
|---|---|
| The run | `WorkflowStarted`, `WorkflowCompleted` (output guardrails and redaction) |
| The user's prompt | `SignalReceived` |
| Each model call | `LLMStarted` (prompt, redacted before the call), `LLMCompleted` (answer, model, token counts) |
| Each tool call | `ToolStarted` (input), `ToolCompleted` (output, status, duration) |
| Chat memory load / save | `ActivityStarted`, `ActivityCompleted` |

Each event can be allowed, blocked, halted or sent for approval.

Not seen: the web requests, database queries and file operations a tool makes
*inside* its own run. The node sees what goes into a tool and what comes out.

## Node settings

### Options

The usual agent settings: **System Message**, **Max Iterations**, **Enable
Streaming**, **Return Intermediate Steps**, **On Tool Error** and
**Automatically Passthrough Binary Images**.

Turn on **Enable Fallback Model** to get a second model input. If the main model
fails, the agent retries on the fallback, which is governed the same way.

### Advanced Governance

The defaults work without changes.

| Setting | Default | Description |
|---|---|---|
| **Governance Events to Send** | all six | Which events are checked: workflow started/completed, LLM started/completed, tool started/completed. |
| **On API Error** | Fail Open | If OpenBox can't be reached, continue ungoverned (Fail Open) or stop the workflow (Fail Closed). |
| **Governance Request Timeout (Seconds)** | `30` | Timeout for each call to OpenBox. |
| **Tools to Exclude From Governance** | *(none)* | Comma-separated tool names that are never checked. |
| **Human-in-the-Loop Approval Enabled** | `true` | Whether to pause for approval when a policy asks for it. |
| **Approval Poll Interval (Seconds)** | `5` | How often to check for a decision. |
| **Approval Max Wait (Seconds)** | `3600` | How long to wait before halting. `0` waits forever. |

## Signed and workload-identity agents

### Signed agents (Agent DID)

For agents with signing required, fill in **Agent DID** and **Agent Private
Key**. Every request to OpenBox is then signed with Ed25519.

### Workload identity (IAM v3)

Agents created in an organisation with an identity provider use a workload
identity. Paste the agent's RSA private key (PKCS8 PEM) into **Workload Private
Key**; a key pasted on one line is fine. For each run the node:

1. reads the agent's workload settings from OpenBox (`GET /api/v3/auth/bootstrap`);
2. signs a one-minute RS256 client assertion with the key and exchanges it with
   the identity provider for an access token;
3. sends every governance request to `/api/v3/*` with the API key plus the token
   in `X-OpenBox-Workload-Token`, and never follows a redirect.

The token lives for one run at most (five minutes cap) and is dropped as soon
as OpenBox rejects it. The private key never leaves n8n: only the signed
assertion goes to the identity provider, and the API key never does.

**This never fails open.** If a token can't be obtained, the run stops with
*OpenBox workload authentication failed* and no governed request is sent, even
with **On API Error** set to Fail Open. A 4xx from a v3 route (other than 401,
403, 408 and 429) also stops the run.

## Limitations

### Each step waits for OpenBox

Every event is a round trip to OpenBox, awaited so the order is kept. Runs with
many tool calls make many calls. If that matters, narrow **Governance Events to
Send**.

### Fail Open loses events silently

With the default **Fail Open**, an outage lets the workflow continue ungoverned
and that run's events are never recorded, with no error shown. Choose **Fail
Closed** if a missing audit trail should stop the run. An invalid API key
(401/403) always stops the run.

### Only work that hasn't happened yet can be stopped

`LLMStarted` and `ToolStarted` are checked before the call, so a block or an
approval request there prevents it. A verdict on a *completed* event stops the
agent going further, but the call has already happened. While waiting for
approval the node holds the run, up to **Approval Max Wait**.

### Token counts come from the model

Model name and token counts are read from the chat model's response. A provider
that doesn't report usage leaves them empty.

### Renaming the node splits history

The agent name comes from the node name, so renaming the node in the canvas
reports under a new agent.

### Queue mode and `n8n execute`

`n8n execute` doesn't support queue mode and quietly falls back to regular mode.
To test a queue-mode worker, run n8n in queue mode and trigger the workflow
(a schedule trigger is simplest).

## What makes it the Cloud Edition

The Cloud Edition is built to meet n8n Cloud's rules for community nodes, so the
same package runs on n8n Cloud and on self-hosted n8n.

| | Cloud Edition |
|---|---|
| **Where it runs** | n8n Cloud and self-hosted n8n |
| **What it watches** | The agent's own steps: the run, the prompt, model calls, tool calls, memory |
| **Each model call** | Question, answer, model and token counts |
| **Each tool call** | What goes in and what comes out |
| **Stopping something** | Before a step starts, or after it finishes |
| **Human approval** | Yes |
| **PII redaction** | Yes |
| **Other workflows on the same n8n** | Not affected |
| **Calls to OpenBox** | One per agent step |

It stays inside its own node:

- It does not patch `fetch`, `http`/`https`, `fs`, database drivers or Node's
  module loader, and does not read `process.env`. A test checks this after a
  full agent run.
- It passes n8n's community-node lint in strict mode, unmodified
  (`npx n8n-node cloud-support` reports ENABLED).
- What a tool does internally (its web requests, database queries and file
  operations) is not seen. Govern those through the tool's input and output, or
  wrap the operation as its own tool so it gets its own check.

## Development

Requires Node.js 20 or later.

```bash
npm ci
npm run build
npm test
npm run lint                    # n8n's Cloud lint rules, unmodified
npx n8n-node cloud-support      # must report ENABLED
```

After publishing, n8n's scanner must pass on the released package:

```bash
npx @n8n/scan-community-package n8n-nodes-openbox-hook
```

### Layout

```text
nodes/OpenBoxAgent/
  OpenBoxAgent.node.ts          the OpenBox: Agent node
  openbox.svg, openbox.dark.svg node icon (light / dark)
credentials/
  OpenBoxApi.credentials.ts     the OpenBox API credential
shared/
  openbox-client.ts             HTTP client for OpenBox Core
  workload-auth.ts              workload identity (IAM v3) tokens
  signing.ts                    Ed25519 request signing
  credential-test.ts            credential Test button
  version.ts                    package version reported to Core
  langchain/
    middleware.ts               governance around the agent
    hooks.ts, hook_handlers.ts, tool_hook.ts
    hitl.ts                     approval polling
    verdict.ts, config.ts, client.ts, error-info.ts, types.ts
tests/                          vitest suites (.mts, see vitest.config.mts)
scripts/                        build helpers
```

`main` and the `n8n` manifest point into `dist/`, which is built on `prepack`
and not committed.

### Contributing

Branch from `main` as `<type>/<short-description>`. Every commit message and PR
title carries a Jira key, and PR titles follow
`[PROD-<n>] <type>(<scope>): <description>`. Releases are covered in
[RELEASING.md](RELEASING.md).

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © OpenBox AI
