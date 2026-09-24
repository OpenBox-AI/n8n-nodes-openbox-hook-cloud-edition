import { NodeApiError } from 'n8n-workflow';
import { describe, expect, it, vi } from 'vitest';

import { GovernanceClient } from '../shared/langchain/client';
import { isGovernanceAuthError, isTransientGovernanceError } from '../shared/openbox-client';

const node = { name: 'OpenBox Agent', type: 'n8n-nodes-openbox-hook.openBoxAgent' };

function makeCtx(opts: { httpRequest?: () => Promise<unknown>; credentials?: unknown }) {
  return {
    getNode: () => node,
    getCredentials: vi.fn().mockResolvedValue(
      'credentials' in opts ? opts.credentials : { apiKey: 'obx_test', openboxUrl: 'http://core.test' },
    ),
    helpers: { httpRequest: vi.fn(opts.httpRequest ?? (async () => ({ verdict: 'allow' }))) },
  };
}

function httpFailure(status?: number): Error {
  const err = new Error(status ? `Request failed with status code ${status}` : 'connect ECONNREFUSED');
  if (status) Object.assign(err, { response: { status } });
  return err;
}

const event = { event_type: 'WorkflowStarted', workflow_id: 'wf', run_id: 'run' } as never;

describe('GovernanceClient error handling', () => {
  it('fails open (returns null) on a transient Core failure by default', async () => {
    const client = new GovernanceClient(makeCtx({ httpRequest: async () => { throw httpFailure(503); } }) as never, 't');
    await expect(client.evaluateEvent(event)).resolves.toBeNull();
  });

  it('surfaces a transient failure as a NodeApiError when fail_closed', async () => {
    const client = new GovernanceClient(makeCtx({ httpRequest: async () => { throw httpFailure(); } }) as never, 't');
    const err = await client.evaluateEvent(event, 'fail_closed').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeApiError);
    expect(isTransientGovernanceError(err)).toBe(true);
  });

  it('always hard-fails on a 401 from Core, keeping the HTTP code, even when fail_open', async () => {
    const client = new GovernanceClient(makeCtx({ httpRequest: async () => { throw httpFailure(401); } }) as never, 't');
    const err = await client.evaluateEvent(event, 'fail_open').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeApiError);
    expect((err as NodeApiError).httpCode).toBe('401');
    expect(isGovernanceAuthError(err)).toBe(true);
  });

  it('never treats a missing credential as a transient failure', async () => {
    const client = new GovernanceClient(makeCtx({ credentials: {} }) as never, 't');
    const err = await client.evaluateEvent(event, 'fail_open').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeApiError);
    expect(isTransientGovernanceError(err)).toBe(false);
    expect(isGovernanceAuthError(err)).toBe(false);
  });

  it('does not mistake some other 401 NodeApiError (e.g. the model provider) for a Core auth failure', () => {
    const providerError = new NodeApiError(node as never, { message: 'bad OpenAI key' }, { httpCode: '401' });
    expect(isGovernanceAuthError(providerError)).toBe(false);
  });
});
