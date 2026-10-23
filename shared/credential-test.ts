import type {
  ICredentialTestFunctions,
  ICredentialsDecrypted,
  IHttpRequestOptions,
  INodeCredentialTestResult,
} from 'n8n-workflow';

import { normalizeOpenBoxCredentials } from '../credentials/OpenBoxApi.credentials';
import { CORE_ROUTES, contractVersionFor } from './openbox-client';
import { buildSignedHeaders } from './signing';
import { WORKLOAD_TOKEN_HEADER, acquireWorkloadAuth } from './workload-auth';

/**
 * n8n gives credential tests only the legacy `helpers.request`
 * (ICredentialTestFunctions), not `httpRequest`. Translate the options this
 * file and workload-auth use; redirects stay off when asked.
 */
function httpRequestVia(ctx: ICredentialTestFunctions): (options: IHttpRequestOptions) => Promise<unknown> {
  return async (options) =>
    await ctx.helpers.request({
      method: options.method ?? 'GET',
      uri: options.url,
      headers: options.headers,
      body: options.body,
      json: options.json ?? false,
      timeout: options.timeout,
      resolveWithFullResponse: options.returnFullResponse ?? false,
      simple: !options.ignoreHttpStatusErrors,
      followRedirect: !options.disableFollowRedirect,
    });
}

/**
 * Shared implementation for testing an OpenBox credential. Call this from every
 * node's `methods.credentialTest.openBoxApiCredentialTest` method so the logic
 * stays in one place.
 */
export async function testOpenBoxCredential(
  this: ICredentialTestFunctions,
  credential: ICredentialsDecrypted,
): Promise<INodeCredentialTestResult> {
  let creds;
  try {
    creds = normalizeOpenBoxCredentials(credential.data ?? {});
  } catch (err) {
    return { status: 'Error', message: (err as Error).message };
  }

  const path = CORE_ROUTES[contractVersionFor(creds)].validate;
  const httpRequest = httpRequestVia(this);

  try {
    let headers;
    if (creds.workloadPrivateKey) {
      headers = buildSignedHeaders('GET', path, Buffer.alloc(0), creds.apiKey);
      // A one-off test, so the token is acquired fresh and never cached.
      const auth = await acquireWorkloadAuth({
        http: httpRequest,
        openboxUrl: creds.openboxUrl,
        coreHeaders: { ...headers },
        privateKeyPem: creds.workloadPrivateKey,
      });
      headers[WORKLOAD_TOKEN_HEADER] = auth.accessToken;
    } else {
      headers = buildSignedHeaders(
        'GET',
        path,
        Buffer.alloc(0),
        creds.apiKey,
        creds.agentDid,
        creds.agentPrivateKey,
      );
    }
    const response = await httpRequest({
      method: 'GET',
      url: `${creds.openboxUrl}${path}`,
      headers,
      json: true,
      ...(creds.workloadPrivateKey ? { disableFollowRedirect: true } : {}),
    });
    // Best-effort response-shape check — Core's exact schema for this endpoint
    // isn't documented, so only an explicit `valid: false` is treated as a
    // failure; anything else that didn't throw is accepted as success.
    if (response && typeof response === 'object' && 'valid' in response && !(response as { valid: unknown }).valid) {
      return { status: 'Error', message: 'OpenBox credential test failed: Core reported the credential as invalid' };
    }
    return { status: 'OK', message: 'Connection successful' };
  } catch (err: unknown) {
    return {
      status: 'Error',
      message: `OpenBox credential test failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
