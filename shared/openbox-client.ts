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

const OPENBOX_TIMEOUT_MS = 35_000;

type RequestContext = IExecuteFunctions | IWebhookFunctions | IHookFunctions;

export interface OpenBoxRequestOptions {
  method: IHttpRequestMethods;
  /** Path beginning with "/", appended to the OpenBox base URL. */
  path: string;
  body?: unknown;
  qs?: Record<string, string | number | boolean | undefined>;
  traceId?: string;
  /** Overrides OPENBOX_TIMEOUT_MS — sourced from GovernanceConfig.governanceTimeout. */
  timeoutMs?: number;
}

export async function getOpenBoxCredentials(
  ctx: RequestContext,
): Promise<OpenBoxCredentials> {
  try {
    const raw = await ctx.getCredentials('openBoxApi');
    if (raw && raw.apiKey) {
      return normalizeOpenBoxCredentials(raw);
    }
  } catch {
    // fall through
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

export async function openboxRequest<T = unknown>(
  ctx: RequestContext,
  options: OpenBoxRequestOptions,
): Promise<T> {
  const credentials = await getOpenBoxCredentials(ctx);

  const url = `${credentials.openboxUrl}${options.path}`;

  // Serialize body before signing so the bytes we hash == the bytes we send.
  const bodyBytes = serializeBody(options.body ?? null);

  const headers = buildSignedHeaders(
    options.method,
    options.path,
    bodyBytes,
    credentials.apiKey,
    credentials.agentDid,
    credentials.agentPrivateKey,
  );

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
  };

  try {
    const raw = await ctx.helpers.httpRequest(requestOptions);
    if (typeof raw === 'string') return JSON.parse(raw) as T;
    if (Buffer.isBuffer(raw)) return JSON.parse(raw.toString('utf-8')) as T;
    return raw as T;
  } catch (err) {
    const statusCode = extractHttpStatusCode(err);
    const apiError = new NodeApiError(ctx.getNode(), err as JsonObject, {
      message: err instanceof Error ? err.message : String(err),
      httpCode: statusCode != null ? String(statusCode) : undefined,
    });
    // Auth/signing failures (401/403) always hard-fail, regardless of
    // onApiError — a revoked/invalid key must never silently degrade to "run
    // ungoverned". Everything else (network, timeout, 5xx) is transient.
    if (statusCode === 401 || statusCode === 403) authErrors.add(apiError);
    else transientErrors.add(apiError);
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

/** True for a 401/403 from Core — always a hard failure. */
export function isGovernanceAuthError(err: unknown): err is NodeApiError {
  return err instanceof NodeApiError && authErrors.has(err);
}
