/**
 * Cloud Edition contract: governance happens only through the node's own
 * lifecycle calls. Constructing the middleware and running every handler must
 * leave the process exactly as it found it — no patched globals, prototypes
 * or module loader (the reason n8n declined verification of the 0.4.x line).
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import Module from 'node:module';

import { describe, expect, it, vi } from 'vitest';

import { NodeOperationError } from 'n8n-workflow';

import { OpenBoxLangChainMiddleware } from '../shared/langchain/middleware';

type Loader = { _load: unknown };

function snapshotGlobals() {
  return {
    fetch: globalThis.fetch,
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
    moduleLoad: (Module as unknown as Loader)._load,
    fsReadFile: fs.readFile,
    fsWriteFile: fs.writeFile,
    fsPromisesReadFile: fs.promises.readFile,
    fsPromisesOpen: fs.promises.open,
  };
}

function makeMiddleware() {
  const executeFunctions = {
    getCredentials: vi.fn(),
    helpers: { httpRequest: vi.fn() },
    getNode: () => ({ name: 'OpenBox Agent', type: 'n8n-nodes-openbox-hook.openBoxAgent' }),
    logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
  };
  const mw = new OpenBoxLangChainMiddleware(
    { agentName: 'CE', hitl: { pollIntervalMs: 1, timeoutMs: 50 } },
    executeFunctions as never,
  );
  const evaluateEvent = vi.fn().mockResolvedValue(null);
  const pollApproval = vi.fn().mockResolvedValue({ verdict: 'allow' });
  Object.assign(mw._client, { evaluateEvent, pollApproval });
  return { mw, evaluateEvent, pollApproval };
}

describe('Cloud Edition installs no process-wide instrumentation', () => {
  it('leaves fetch, http/https, fs and the module loader untouched across a full turn', async () => {
    const before = snapshotGlobals();

    const { mw } = makeMiddleware();
    const turn = await mw.beforeAgent({ messages: [['human', 'hi']] });
    await mw.wrapMemoryOp(turn, 'load_memory', async () => ({ chat_history: [] }));
    await mw.wrapModelCall(turn, [['human', 'hi']], async () => ({ content: 'hello' }));
    await mw.wrapToolCall(turn, 'search', { q: 'x' }, async () => 'result');
    await mw.afterAgent(turn, { messages: [] });

    expect(snapshotGlobals()).toEqual(before);
  });
});

describe('lifecycle governance without span hooks', () => {
  it('calls the tool exactly once and reports ToolStarted/ToolCompleted on one activity id', async () => {
    const { mw, evaluateEvent } = makeMiddleware();
    const turn = { workflowId: 'wf', runId: 'run' };
    const tool = vi.fn().mockResolvedValue('ok');

    await expect(mw.wrapToolCall(turn, 'search', { q: 'x' }, tool)).resolves.toBe('ok');

    expect(tool).toHaveBeenCalledTimes(1);
    const events = evaluateEvent.mock.calls.map(([e]) => e);
    expect(events.map((e) => e.event_type)).toEqual(['ToolStarted', 'ToolCompleted']);
    expect(events[0].activity_id).toBe(events[1].activity_id);
    expect(events[1].status).toBe('completed');
  });

  it('does not enforce the ToolCompleted verdict again once ToolStarted was approved', async () => {
    const { mw, evaluateEvent, pollApproval } = makeMiddleware();
    evaluateEvent
      .mockResolvedValueOnce({ verdict: 'require_approval' })
      .mockResolvedValueOnce({ verdict: 'require_approval' });

    await mw.wrapToolCall({ workflowId: 'wf', runId: 'run' }, 'search', {}, async () => 'ok');

    expect(pollApproval).toHaveBeenCalledTimes(1);
  });

  it('closes the llm_call row as failed when the model call throws, then rethrows it as a node error', async () => {
    const { mw, evaluateEvent } = makeMiddleware();
    const boom = new Error('provider down');

    const thrown = await mw
      .wrapModelCall({ workflowId: 'wf', runId: 'run' }, [['human', 'hi']], async () => {
        throw boom;
      })
      .catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(NodeOperationError);
    expect((thrown as NodeOperationError).message).toBe('provider down');

    const events = evaluateEvent.mock.calls.map(([e]) => e);
    expect(events.map((e) => e.event_type)).toEqual(['LLMStarted', 'LLMCompleted']);
    expect(events[1].status).toBe('failed');
    expect(events[0].activity_id).toBe(events[1].activity_id);
  });

  it('reports a failed memory op as a failed ActivityCompleted and rethrows it as a node error', async () => {
    const { mw, evaluateEvent } = makeMiddleware();
    const boom = new Error('memory store down');

    await expect(
      mw.wrapMemoryOp({ workflowId: 'wf', runId: 'run' }, 'save_context', async () => {
        throw boom;
      }),
    ).rejects.toBeInstanceOf(NodeOperationError);

    const events = evaluateEvent.mock.calls.map(([e]) => e);
    expect(events.map((e) => [e.event_type, e.status])).toEqual([
      ['ActivityStarted', undefined],
      ['ActivityCompleted', 'failed'],
    ]);
  });
});
