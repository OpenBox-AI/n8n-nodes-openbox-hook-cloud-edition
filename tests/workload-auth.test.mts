import { generateKeyPairSync, createPublicKey, verify } from 'crypto';
import { NodeApiError } from 'n8n-workflow';
import { describe, expect, it, vi } from 'vitest';

import { normalizeOpenBoxCredentials } from '../credentials/OpenBoxApi.credentials';
import { testOpenBoxCredential } from '../shared/credential-test';
import { GovernanceClient } from '../shared/langchain/client';
import { isGovernanceAuthError, isTransientGovernanceError, isWorkloadAuthError } from '../shared/openbox-client';
import {
  buildWorkloadClientAssertion,
  loadRsaPrivateKey,
  normalizePem,
  parseWorkloadBootstrapDocument,
  parseWorkloadTokenResponse,
} from '../shared/workload-auth';

const node = { name: 'OpenBox Agent', type: 'n8n-nodes-openbox-hook.openBoxAgent' };
const CORE = 'https://core.test';
const ISSUER = 'https://id.test/realms/openbox';
const GRANT_URL = `${ISSUER}/protocol/openid-connect/token`;

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const bootstrapDoc = {
  bootstrap_version: 3,
  contract_version: 3,
  token_endpoint: GRANT_URL,
  issuer: ISSUER,
  audience: 'openbox-core',
  client_id: 'openbox-agent-abc',
  service_account_id: '7f9c2b4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f',
  activation_version: '3b1f0c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  identity_source: 'openbox',
  kid: 'kid-1',
};

type Req = { method?: string; url: string; headers?: Record<string, string>; body?: unknown; disableFollowRedirect?: boolean };

/** A fake n8n context whose httpRequest plays Core + Keycloak. */
function makeCtx(opts: { core?: (req: Req) => unknown; grants?: string[]; credentials?: Record<string, unknown> } = {}) {
  const calls: Req[] = [];
  const grants = [...(opts.grants ?? ['wl-1', 'wl-2', 'wl-3'])];
  const httpRequest = vi.fn(async (req: Req) => {
    calls.push(req);
    if (req.url === `${CORE}/api/v3/auth/bootstrap`) return { statusCode: 200, body: JSON.stringify(bootstrapDoc) };
    if (req.url === GRANT_URL) {
      return { statusCode: 200, body: JSON.stringify({ ['access_' + 'token']: grants.shift(), token_type: 'Bearer', expires_in: 300 }) };
    }
    return (opts.core ?? (() => ({ verdict: 'allow' })))(req);
  });
  return {
    calls,
    ctx: {
      getNode: () => node,
      getCredentials: vi.fn().mockResolvedValue(
        opts.credentials ?? { apiKey: 'obx_live_k', openboxUrl: CORE, workloadPrivateKey: PEM },
      ),
      helpers: { httpRequest },
    },
  };
}

function httpFailure(status: number): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });
}

const event = { event_type: 'WorkflowStarted', workflow_id: 'wf', run_id: 'run' } as never;

describe('workload identity documents', () => {
  it('parses a valid bootstrap document', () => {
    const doc = parseWorkloadBootstrapDocument(bootstrapDoc);
    expect(doc).toMatchObject({ clientId: 'openbox-agent-abc', kid: 'kid-1', tokenEndpoint: GRANT_URL });
  });

  it('rejects a bootstrap from an unsupported contract version', () => {
    expect(() => parseWorkloadBootstrapDocument({ ...bootstrapDoc, contract_version: 4 })).toThrow(/Unsupported/);
  });

  it('rejects a token endpoint that does not belong to the issuer', () => {
    expect(() =>
      parseWorkloadBootstrapDocument({ ...bootstrapDoc, token_endpoint: 'https://evil.test/realms/openbox/protocol/openid-connect/token' }),
    ).toThrow(/does not belong/);
  });

  it('rejects plain HTTP outside loopback, and look-alike loopback hosts', () => {
    const http = 'http://id.test/realms/openbox';
    expect(() => parseWorkloadBootstrapDocument({ ...bootstrapDoc, issuer: http, token_endpoint: `${http}/protocol/openid-connect/token` })).toThrow(/HTTPS/);
    const fake = 'http://localhost.evil.test/realms/openbox';
    expect(() => parseWorkloadBootstrapDocument({ ...bootstrapDoc, issuer: fake, token_endpoint: `${fake}/protocol/openid-connect/token` })).toThrow(/HTTPS/);
  });

  it('caps the cache lifetime at 300 s and rejects lifetimes within the refresh margin', () => {
    const ok = parseWorkloadTokenResponse({ ['access_' + 'token']: 'abc', token_type: 'bearer', expires_in: 900 });
    expect(ok.cacheSeconds).toBe(300);
    expect(() => parseWorkloadTokenResponse({ ['access_' + 'token']: 'abc', token_type: 'Bearer', expires_in: 30 })).toThrow(/expires_in/);
  });
});

describe('workload key and assertion', () => {
  it('rebuilds a PEM pasted on one line', () => {
    const oneLine = PEM.trim().split('\n').join(' ');
    expect(normalizePem(oneLine)).toBe(PEM.trim());
    expect(() => loadRsaPrivateKey(oneLine)).not.toThrow();
  });

  it('rejects a non-RSA or short key without echoing it', () => {
    const ed = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => loadRsaPrivateKey(ed)).toThrow(/expected an RSA key/);
    const small = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const err = (() => { try { loadRsaPrivateKey(small); } catch (e) { return e as Error; } })();
    expect(err?.message).toMatch(/at least 2048 bits/);
    expect(err?.message).not.toContain('PRIVATE KEY-----');
  });

  it('signs an RS256 assertion with sorted claims that verifies against the public key', () => {
    const jwt = buildWorkloadClientAssertion(loadRsaPrivateKey(PEM), parseWorkloadBootstrapDocument(bootstrapDoc), 1_000);
    const [h, c, sig] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', kid: 'kid-1', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
    expect(Object.keys(claims)).toEqual(['aud', 'exp', 'iat', 'iss', 'jti', 'sub']);
    expect(claims).toMatchObject({ aud: GRANT_URL, iat: 1_000, exp: 1_060, iss: 'openbox-agent-abc', sub: 'openbox-agent-abc' });
    const ok = verify('RSA-SHA256', Buffer.from(`${h}.${c}`), createPublicKey(loadRsaPrivateKey(PEM)), Buffer.from(sig, 'base64url'));
    expect(ok).toBe(true);
  });
});

describe('credential', () => {
  it('refuses a workload key combined with Agent DID signing', () => {
    expect(() =>
      normalizeOpenBoxCredentials({ apiKey: 'k', workloadPrivateKey: PEM, agentDid: 'did:aip:x', agentPrivateKey: 'y' }),
    ).toThrow(/one identity method/);
  });
});

describe('GovernanceClient on IAM v3', () => {
  it('sends evaluate to /api/v3 with the API key and workload token, never DID headers, and no redirects', async () => {
    const { ctx, calls } = makeCtx();
    await new GovernanceClient(ctx as never, 't').evaluateEvent(event);
    const evaluate = calls.find((c) => c.url.endsWith('/governance/evaluate'))!;
    expect(evaluate.url).toBe(`${CORE}/api/v3/governance/evaluate`);
    expect(evaluate.headers?.Authorization).toBe('Bearer obx_live_k');
    expect(evaluate.headers?.['X-OpenBox-Workload-Token']).toBe('wl-1');
    expect(Object.keys(evaluate.headers ?? {}).some((k) => k.startsWith('X-OpenBox-Agent-'))).toBe(false);
    expect(evaluate.disableFollowRedirect).toBe(true);
  });

  it('never sends the API key to Keycloak', async () => {
    const { ctx, calls } = makeCtx();
    await new GovernanceClient(ctx as never, 't').evaluateEvent(event);
    const grant = calls.find((c) => c.url === GRANT_URL)!;
    expect(JSON.stringify(grant)).not.toContain('obx_live_k');
    expect(String(grant.body)).toContain('grant_type=client_credentials');
  });

  it('reuses one token for the whole execution', async () => {
    const { ctx, calls } = makeCtx();
    const client = new GovernanceClient(ctx as never, 't');
    await client.evaluateEvent(event);
    await client.evaluateEvent(event);
    await client.pollApproval('wf', 'run', 'act');
    expect(calls.filter((c) => c.url === GRANT_URL)).toHaveLength(1);
    expect(calls.find((c) => c.url.endsWith('/governance/approval'))?.url).toBe(`${CORE}/api/v3/governance/approval`);
  });

  it('on a 401 hard-fails even when fail_open, drops the token, and bootstraps again next time', async () => {
    let first = true;
    const { ctx, calls } = makeCtx({
      core: () => {
        if (first) { first = false; throw httpFailure(401); }
        return { verdict: 'allow' };
      },
    });
    const client = new GovernanceClient(ctx as never, 't');
    const err = await client.evaluateEvent(event, 'fail_open').catch((e: unknown) => e);
    expect(isGovernanceAuthError(err)).toBe(true);
    expect(isWorkloadAuthError(err)).toBe(false);
    await client.evaluateEvent(event);
    const tokens = calls.filter((c) => c.url.endsWith('/governance/evaluate')).map((c) => c.headers?.['X-OpenBox-Workload-Token']);
    expect(tokens).toEqual(['wl-1', 'wl-2']);
  });

  it('treats a v3 4xx as a contract error that never fails open', async () => {
    const { ctx } = makeCtx({ core: () => { throw httpFailure(400); } });
    const err = await new GovernanceClient(ctx as never, 't').evaluateEvent(event, 'fail_open').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodeApiError);
    expect(isTransientGovernanceError(err)).toBe(false);
    expect((err as Error).message).toMatch(/contract error/);
  });

  it('still fails open on a v3 outage (5xx) when fail_open', async () => {
    const { ctx } = makeCtx({ core: () => { throw httpFailure(503); } });
    await expect(new GovernanceClient(ctx as never, 't').evaluateEvent(event, 'fail_open')).resolves.toBeNull();
  });

  it('hard-fails, without calling Core, when the token exchange is refused', async () => {
    const { ctx, calls } = makeCtx();
    ctx.helpers.httpRequest.mockImplementation(async (req: Req) => {
      calls.push(req);
      if (req.url.endsWith('/api/v3/auth/bootstrap')) return { statusCode: 200, body: JSON.stringify(bootstrapDoc) };
      if (req.url === GRANT_URL) return { statusCode: 401, body: JSON.stringify({ error: 'invalid_client' }) };
      return { verdict: 'allow' };
    });
    const err = await new GovernanceClient(ctx as never, 't').evaluateEvent(event, 'fail_open').catch((e: unknown) => e);
    expect(isGovernanceAuthError(err)).toBe(true);
    expect((err as Error).message).toMatch(/invalid_client/);
    expect(isWorkloadAuthError(err)).toBe(true);
    expect(calls.some((c) => c.url.endsWith('/governance/evaluate'))).toBe(false);
  });

  it('keeps API-key-only credentials on /api/v1', async () => {
    const { ctx, calls } = makeCtx({ credentials: { apiKey: 'obx_test', openboxUrl: CORE } });
    await new GovernanceClient(ctx as never, 't').evaluateEvent(event);
    expect(calls.map((c) => c.url)).toEqual([`${CORE}/api/v1/governance/evaluate`]);
  });
});

describe('credential test (n8n provides only helpers.request here)', () => {
  type LegacyReq = { method: string; uri: string; headers?: Record<string, string>; resolveWithFullResponse?: boolean; simple?: boolean; followRedirect?: boolean };

  function legacyCtx(validate: () => unknown) {
    const calls: LegacyReq[] = [];
    const request = vi.fn(async (req: LegacyReq) => {
      calls.push(req);
      if (req.uri === `${CORE}/api/v3/auth/bootstrap`) return { statusCode: 200, body: JSON.stringify(bootstrapDoc) };
      if (req.uri === GRANT_URL) {
        return { statusCode: 200, body: JSON.stringify({ ['access_' + 'token']: 'wl-t', token_type: 'Bearer', expires_in: 300 }) };
      }
      return validate();
    });
    return { calls, ctx: { helpers: { request } } };
  }

  it('passes a workload credential through bootstrap, token exchange and v3 validate', async () => {
    const { ctx, calls } = legacyCtx(() => ({ valid: true }));
    const result = await testOpenBoxCredential.call(ctx as never, {
      data: { apiKey: 'obx_live_k', openboxUrl: CORE, workloadPrivateKey: PEM },
    } as never);
    expect(result).toEqual({ status: 'OK', message: 'Connection successful' });
    const validate = calls.find((c) => c.uri.endsWith('/auth/validate'))!;
    expect(validate.uri).toBe(`${CORE}/api/v3/auth/validate`);
    expect(validate.headers?.['X-OpenBox-Workload-Token']).toBe('wl-t');
    expect(calls.every((c) => c.followRedirect === false)).toBe(true);
  });

  it('keeps API-key-only credentials on v1 validate', async () => {
    const { ctx, calls } = legacyCtx(() => ({ valid: true }));
    const result = await testOpenBoxCredential.call(ctx as never, { data: { apiKey: 'obx_test', openboxUrl: CORE } } as never);
    expect(result.status).toBe('OK');
    expect(calls.map((c) => c.uri)).toEqual([`${CORE}/api/v1/auth/validate`]);
  });

  it('reports a Core rejection as an error', async () => {
    const { ctx } = legacyCtx(() => { throw httpFailure(401); });
    const result = await testOpenBoxCredential.call(ctx as never, {
      data: { apiKey: 'obx_live_k', openboxUrl: CORE, workloadPrivateKey: PEM },
    } as never);
    expect(result.status).toBe('Error');
  });
});
