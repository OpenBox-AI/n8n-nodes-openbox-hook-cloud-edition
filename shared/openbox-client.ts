import {
  IExecuteFunctions,
  IHookFunctions,
  IHttpRequestMethods,
  IHttpRequestOptions,
  IWebhookFunctions,
  JsonObject,
  NodeApiError,
} from 'n8n-workflow';

import {
  OpenBoxCredentials,
  normalizeOpenBoxCredentials,
} from '../credentials/OpenBoxApi.credentials';
import { buildSignedHeaders, serializeBody } from './signing';
import {
  WORKLOAD_TOKEN_HEADER,
  WorkloadAuthState,
  getWorkloadAuth,
  invalidateWorkloadAuth,
} from './workload-auth';

const OPENBOX_TIMEOUT_MS = 35_000;

type RequestContext = IExecuteFunctions | IWebhookFunctions | IHookFunctions;

export type CoreRoute = 'evaluate' | 'approval' | 'validate';
export type ContractVersion = 1 | 3;

/**
 * Core's routes per contract: v1 for API-key-only and Agent DID signing, v3
 * for Keycloak workload identity. The version is fixed by the credential and
 * a request never falls back from one to the other.
 */
export const CORE_ROUTES: Record<ContractVersion, Record<CoreRoute, string>> = {
  1: {
    evaluate: '/api/v1/governance/evaluate',
    approval: '/api/v1/governance/approval',
    validate: '/api/v1/auth/validate',
  },
  3: {
    evaluate: '/api/v3/governance/evaluate',
    approval: '/api/v3/governance/approval',
    validate: '/api/v3/auth/validate',
  },
};

export function contractVersionFor(credentials: OpenBoxCredentials): ContractVersion {
  return credentials.workloadPrivateKey ? 3 : 1;
}

export interface OpenBoxRequestOptions {
  method: IHttpRequestMethods;
  route: CoreRoute;
  body?: unknown;
  qs?: Record<string, string | number | boolean | undefined>;
  traceId?: string;
  /** Overrides OPENBOX_TIMEOUT_MS — sourced from GovernanceConfig.governanceTimeout. */
  timeoutMs?: number;
}

export async function getOpenBoxCredentials(
  ctx: RequestContext,
): Promise<OpenBoxCredentials> {
  let raw;
  try {
    raw = await ctx.getCredentials('openBoxApi');
  } catch {
    // fall through
  }
  if (raw && raw.apiKey) {
    try {
      return normalizeOpenBoxCredentials(raw);
    } catch (err) {
      throw new NodeApiError(ctx.getNode(), {
        message: err instanceof Error ? err.message : String(err),
      } as JsonObject);
    }
  }

  throw new NodeApiError(ctx.getNode(), {
    message: 'OpenBox API key not set',
    description: 'Attach an OpenBox credential to this node.',
  } as JsonObject);
}

/**
 * Failures of requests to Core, by kind. Tracked by identity rather than by
 * type so that other NodeApiErrors — a missing credential, or a 401 from the
 * model provider — are never mistaken for one.
 */
const transientErrors = new WeakSet<NodeApiError>();
const authErrors = new WeakSet<NodeApiError>();
/** The subset of authErrors raised before any request reached Core. */
const workloadAuthErrors = new WeakSet<NodeApiError>();

/**
 * v3 answers that are contract errors rather than outages: a redirect (never
 * followed on v3) and every 4xx except auth (401/403) and the retryable
 * 408/429. They are neither transient nor auth errors, so they always fail.
 */
function isV3ContractError(statusCode: number | null): boolean {
  if (statusCode == null) return false;
  if (statusCode >= 300 && statusCode < 400) return true;
  return statusCode >= 400 && statusCode < 500 && ![401, 403, 408, 429].includes(statusCode);
}

export async function openboxRequest<T = unknown>(
  ctx: RequestContext,
  options: OpenBoxRequestOptions,
): Promise<T> {
  const credentials = await getOpenBoxCredentials(ctx);
  const contractVersion = contractVersionFor(credentials);
  const path = CORE_ROUTES[contractVersion][options.route];
  const url = `${credentials.openboxUrl}${path}`;

  // Serialize body before signing so the bytes we hash == the bytes we send.
  const bodyBytes = serializeBody(options.body ?? null);

  let headers;
  let workloadAuth: WorkloadAuthState | null = null;
  if (credentials.workloadPrivateKey) {
    // v3 sends only the API key, SDK headers and the raw workload token —
    // never DID signature headers.
    headers = buildSignedHeaders(options.method, path, bodyBytes, credentials.apiKey);
    try {
      workloadAuth = await getWorkloadAuth(ctx, {
        http: (opts) => ctx.helpers.httpRequest(opts),
        openboxUrl: credentials.openboxUrl,
        coreHeaders: { ...headers },
        privateKeyPem: credentials.workloadPrivateKey,
      });
    } catch (err) {
      // Failing to authenticate is never an outage: it must not fail open.
      const apiError = new NodeApiError(ctx.getNode(), err as JsonObject, {
        message: err instanceof Error ? err.message : String(err),
      });
      authErrors.add(apiError);
      workloadAuthErrors.add(apiError);
      throw apiError;
    }
    headers[WORKLOAD_TOKEN_HEADER] = workloadAuth.accessToken;
  } else {
    headers = buildSignedHeaders(
      options.method,
      path,
      bodyBytes,
      credentials.apiKey,
      credentials.agentDid,
      credentials.agentPrivateKey,
    );
  }

  if (options.traceId) {
    headers['X-OpenBox-Trace-Id'] = options.traceId;
  }

  const requestOptions: IHttpRequestOptions = {
    method: options.method,
    url,
    headers,
    json: false,
    timeout: options.timeoutMs ?? OPENBOX_TIMEOUT_MS,
    body: bodyBytes.length > 0 ? (bodyBytes as unknown as IHttpRequestOptions['body']) : undefined,
    qs: options.qs as IHttpRequestOptions['qs'],
    returnFullResponse: false,
    ignoreHttpStatusErrors: false,
    // Following a redirect would hand the reusable workload token to another host.
    ...(contractVersion === 3 ? { disableFollowRedirect: true } : {}),
  };

  try {
    const raw = await ctx.helpers.httpRequest(requestOptions);
    if (typeof raw === 'string') return JSON.parse(raw) as T;
    if (Buffer.isBuffer(raw)) return JSON.parse(raw.toString('utf-8')) as T;
    return raw as T;
  } catch (err) {
    const statusCode = extractHttpStatusCode(err);
    let message = err instanceof Error ? err.message : String(err);
    if (workloadAuth && (statusCode === 401 || statusCode === 403)) {
      // Core collapses identity failures into a generic 401, so drop the token
      // this request carried; the next request bootstraps again. Not replayed.
      invalidateWorkloadAuth(ctx, workloadAuth);
      message =
        `OpenBox Core rejected the workload-authenticated ${options.route} request (HTTP ${statusCode}). ` +
        "The cached workload token was discarded; check the agent's active workload identity if this persists.";
    } else if (contractVersion === 3 && isV3ContractError(statusCode)) {
      message =
        `OpenBox Core rejected the v3 ${options.route} request (HTTP ${statusCode}). ` +
        'This is a contract error, not an outage, so it never fails open; check that this node and Core are compatible.';
    }
    const apiError = new NodeApiError(ctx.getNode(), err as JsonObject, {
      message,
      httpCode: statusCode != null ? String(statusCode) : undefined,
    });
    // Auth/signing failures (401/403) always hard-fail, regardless of
    // onApiError — a revoked/invalid key must never silently degrade to "run
    // ungoverned". A v3 contract error hard-fails too. Everything else
    // (network, timeout, 5xx) is transient.
    if (statusCode === 401 || statusCode === 403) authErrors.add(apiError);
    else if (!(contractVersion === 3 && isV3ContractError(statusCode))) transientErrors.add(apiError);
    throw apiError;
  }
}

/**
 * Best-effort extraction of an HTTP status code from whatever shape n8n's
 * httpRequest helper (or an upstream NodeApiError) throws. Different n8n
 * versions/transports surface this differently, so several paths are tried.
 */
function extractHttpStatusCode(err: unknown): number | null {
  if (err == null || typeof err !== 'object') return null;
  const e = err as Record<string, unknown>;
  const candidates: unknown[] = [
    e.statusCode,
    e.httpCode,
    (e.response as Record<string, unknown> | undefined)?.statusCode,
    (e.response as Record<string, unknown> | undefined)?.status,
    (e.cause as Record<string, unknown> | undefined)?.statusCode,
    ((e.cause as Record<string, unknown> | undefined)?.response as Record<string, unknown> | undefined)?.status,
  ];
  for (const c of candidates) {
    const n = typeof c === 'string' ? Number(c) : c;
    if (typeof n === 'number' && Number.isFinite(n)) return n;
  }
  return null;
}

/** True for a transient OpenBox API failure (see transientErrors). */
export function isTransientGovernanceError(err: unknown): err is NodeApiError {
  return err instanceof NodeApiError && transientErrors.has(err);
}

/** True when no workload token could be obtained, so nothing was sent to Core. */
export function isWorkloadAuthError(err: unknown): err is NodeApiError {
  return err instanceof NodeApiError && workloadAuthErrors.has(err);
}

/** True for a 401/403 from Core, or a failed workload authentication — always a hard failure. */
export function isGovernanceAuthError(err: unknown): err is NodeApiError {
  return err instanceof NodeApiError && authErrors.has(err);
}
