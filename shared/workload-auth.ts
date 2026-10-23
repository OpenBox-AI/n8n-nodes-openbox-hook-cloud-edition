/**
 * IAM v3 workload authentication (`keycloak_workload`): Core bootstrap →
 * RFC 7523 `private_key_jwt` → Keycloak client-credentials access token.
 *
 * Port of openbox-sdk-ts 2.1.0 (client/workload-authenticator.ts,
 * client/workload-documents.ts, identity/workload.ts,
 * identity/rsa-private-key.ts). Every request goes through the caller's
 * `httpRequest` helper, so nothing here patches or reads process-wide state.
 *
 * Tokens are cached per owner object (one n8n execution context), never
 * process-wide: at most 300 s, renewed 30 s early, and dropped as soon as
 * Core rejects a request that carried them. Every acquisition re-fetches the
 * bootstrap document, so a changed workload identity is picked up on renewal.
 */

import { createPrivateKey, randomBytes, sign as cryptoSign } from 'crypto';
import type { KeyObject } from 'crypto';
import type { IHttpRequestOptions } from 'n8n-workflow';

export const BOOTSTRAP_PATH_V3 = '/api/v3/auth/bootstrap';
/** Header carrying the raw (un-prefixed) workload access token on v3 routes. */
export const WORKLOAD_TOKEN_HEADER = 'X-OpenBox-Workload-Token';

const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const CLIENT_ASSERTION_LIFETIME_SECONDS = 60;
const WORKLOAD_BOOTSTRAP_VERSION = 3;
const WORKLOAD_CONTRACT_VERSION = 3;
const OIDC_GRANT_PATH = '/protocol/openid-connect/token';
const ACCESS_TOKEN_REFRESH_MARGIN_SECONDS = 30;
const MAX_ACCESS_TOKEN_CACHE_SECONDS = 300;
const MIN_RSA_MODULUS_BITS = 2048;
const WORKLOAD_IDENTITY_SOURCES = ['openbox', 'okta', 'entra'];
const WORKLOAD_AUTH_TIMEOUT_MS = 30_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
// A header-safe opaque token: visible ASCII only (JWTs are base64url segments and dots).
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export type WorkloadAuthStage = 'config' | 'bootstrap' | 'token';

/** Validated, non-secret metadata for the agent's active service account. */
export interface WorkloadBootstrapDocument {
  tokenEndpoint: string;
  issuer: string;
  audience: string;
  clientId: string;
  serviceAccountId: string;
  activationVersion: string;
  identitySource: string;
  kid: string;
}

/** One acquisition: the token always comes with the bootstrap it was issued against. */
export interface WorkloadAuthState {
  metadata: WorkloadBootstrapDocument;
  accessToken: string;
  /** Date.now() from which this state must no longer be used. */
  refreshAtMs: number;
}

export type HttpRequestFn = (options: IHttpRequestOptions) => Promise<unknown>;

interface FullResponse {
  statusCode: number;
  body: unknown;
}

/**
 * Accept the PEM as pasted into a single-line n8n field: literal "\n"
 * escapes, or the whole key on one line with spaces where the newlines were.
 */
export function normalizePem(raw: string): string {
  const pem = raw.trim().replace(/\\n/g, '\n');
  if (pem.includes('\n')) return pem;
  const match = /^(-----BEGIN [A-Z ]+-----)\s*(.+?)\s*(-----END [A-Z ]+-----)$/.exec(pem);
  if (!match) return pem;
  const body = match[2].replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g) ?? [];
  return [match[1], ...lines, match[3]].join('\n');
}

/**
 * Load a PKCS8 PEM RSA private key, rejecting non-RSA keys and keys under
 * 2048 bits before any request is made. Errors never include key bytes.
 */
export function loadRsaPrivateKey(pem: string): KeyObject {
  const normalized = normalizePem(pem);
  if (!normalized.includes('PRIVATE KEY')) {
    fail('config', 'Invalid Workload Private Key: expected a PKCS8 PEM-encoded RSA private key (key bytes not shown).');
  }
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: normalized, format: 'pem', type: 'pkcs8' });
  } catch {
    fail('config', 'Invalid Workload Private Key: could not load a PKCS8 PEM RSA key (key bytes not shown).');
  }
  if (key.asymmetricKeyType !== 'rsa') {
    fail('config', `Invalid Workload Private Key: expected an RSA key, got '${String(key.asymmetricKeyType)}' (key bytes not shown).`);
  }
  const modulusBits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (modulusBits < MIN_RSA_MODULUS_BITS) {
    fail('config', `Invalid Workload Private Key: RSA modulus must be at least ${MIN_RSA_MODULUS_BITS} bits, got ${modulusBits} (key bytes not shown).`);
  }
  return key;
}

/**
 * A failure to obtain a workload token. Never an outage: callers wrap it in a
 * NodeApiError and must not fail open on it. Messages never contain key or
 * token material.
 */
function fail(stage: WorkloadAuthStage, message: string): never {
  throw new Error(`OpenBox workload authentication failed (${stage}): ${message}`);
}

function requireObject(raw: unknown, what: string, stage: WorkloadAuthStage): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail(stage, `${what} is invalid: expected a JSON object.`);
  }
  return raw as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, key: string, what: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '') {
    fail('bootstrap', `${what} is invalid: '${key}' must be a non-empty string.`);
  }
  return value;
}

function requireUuid(body: Record<string, unknown>, key: string, what: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !UUID_PATTERN.test(value) || value === NIL_UUID) {
    fail('bootstrap', `${what} is invalid: '${key}' must be a canonical, non-nil UUID.`);
  }
  return value.toLowerCase();
}

/**
 * An absolute HTTPS URL (plain HTTP only for loopback hosts) with no user
 * information, query or fragment. The host is compared exactly, never by
 * substring, so `localhost.evil.example` is not loopback.
 */
function requireSafeUrl(value: string, key: string, what: string): void {
  const invalid = (): never =>
    fail(
      'bootstrap',
      `${what} is invalid: '${key}' must be an absolute HTTPS URL (HTTP only for localhost, 127.0.0.1, ` +
        'or ::1) without user information, query, or fragment.',
    );
  // Checked on the raw string: URL parsing silently drops an empty `?`/`#` and trims whitespace.
  if (/[\s\\?#]/.test(value)) invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid();
  }
  if (url.username || url.password || !url.hostname) invalid();
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  if (!secure) invalid();
}

/** Parse and validate Core's `GET /api/v3/auth/bootstrap` response. */
export function parseWorkloadBootstrapDocument(raw: unknown): WorkloadBootstrapDocument {
  const what = 'Workload bootstrap response';
  const body = requireObject(raw, what, 'bootstrap');
  for (const [key, expected] of [
    ['bootstrap_version', WORKLOAD_BOOTSTRAP_VERSION],
    ['contract_version', WORKLOAD_CONTRACT_VERSION],
  ] as const) {
    if (body[key] !== expected) {
      fail(
        'bootstrap',
        `Unsupported workload bootstrap ${key} ${JSON.stringify(body[key])}; this node supports ${expected}. ` +
          'Upgrade n8n-nodes-openbox-hook to match your OpenBox Core deployment.',
      );
    }
  }

  const issuer = requireString(body, 'issuer', what);
  const tokenEndpoint = requireString(body, 'token_endpoint', what);
  requireSafeUrl(issuer, 'issuer', what);
  requireSafeUrl(tokenEndpoint, 'token_endpoint', what);
  const expectedEndpoint = `${issuer.endsWith('/') ? issuer.slice(0, -1) : issuer}${OIDC_GRANT_PATH}`;
  if (tokenEndpoint !== expectedEndpoint) {
    fail('bootstrap', `${what} is invalid: 'token_endpoint' does not belong to the advertised issuer.`);
  }

  const identitySource = body.identity_source;
  if (typeof identitySource !== 'string' || !WORKLOAD_IDENTITY_SOURCES.includes(identitySource)) {
    fail(
      'bootstrap',
      `${what} is invalid: 'identity_source' must be one of ${WORKLOAD_IDENTITY_SOURCES.join(', ')}.`,
    );
  }

  return {
    tokenEndpoint,
    issuer,
    audience: requireString(body, 'audience', what),
    clientId: requireString(body, 'client_id', what),
    serviceAccountId: requireUuid(body, 'service_account_id', what),
    activationVersion: requireUuid(body, 'activation_version', what),
    identitySource,
    kid: requireString(body, 'kid', what),
  };
}

/** Parse Keycloak's client-credentials response and bound its cache lifetime. */
export function parseWorkloadTokenResponse(raw: unknown): { accessToken: string; cacheSeconds: number } {
  const what = 'Keycloak workload token response';
  const body = requireObject(raw, what, 'token');
  const issued = body['access_token'];
  if (typeof issued !== 'string' || !VISIBLE_ASCII.test(issued)) {
    fail('token', `${what} is invalid: 'access_token' must be a non-empty token string.`);
  }
  const tokenType = body.token_type;
  if (typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer') {
    fail('token', `${what} is invalid: 'token_type' must be Bearer.`);
  }
  const expiresIn = body.expires_in;
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= ACCESS_TOKEN_REFRESH_MARGIN_SECONDS) {
    fail(
      'token',
      `${what} is invalid: 'expires_in' must be a number of seconds greater than ${ACCESS_TOKEN_REFRESH_MARGIN_SECONDS}.`,
    );
  }
  return { accessToken: issued, cacheSeconds: Math.min(expiresIn, MAX_ACCESS_TOKEN_CACHE_SECONDS) };
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf-8').toString('base64url');
}

/**
 * The RS256 client assertion presented to Keycloak. Keys are in sorted order,
 * matching the other OpenBox SDKs byte for byte.
 */
export function buildWorkloadClientAssertion(
  signer: KeyObject,
  target: Pick<WorkloadBootstrapDocument, 'clientId' | 'kid' | 'tokenEndpoint'>,
  issuedAt: number = Math.floor(Date.now() / 1000),
): string {
  const header = { alg: 'RS256', kid: target.kid, typ: 'JWT' };
  const claims = {
    aud: target.tokenEndpoint,
    exp: issuedAt + CLIENT_ASSERTION_LIFETIME_SECONDS,
    iat: issuedAt,
    iss: target.clientId,
    jti: randomBytes(24).toString('base64url'),
    sub: target.clientId,
  };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const signature = cryptoSign('RSA-SHA256', Buffer.from(signingInput, 'utf-8'), signer);
  return `${signingInput}.${signature.toString('base64url')}`;
}

function parseBody(body: unknown, what: string, stage: WorkloadAuthStage): unknown {
  if (Buffer.isBuffer(body)) body = body.toString('utf-8');
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    return fail(stage, `${what} is invalid: body is not valid JSON.`);
  }
}

/** Short, non-secret detail from an error body (Core's `message`, or an OAuth `error`). */
function errorDetail(body: unknown): string {
  try {
    const parsed = parseBody(body, '', 'bootstrap') as Record<string, unknown> | null;
    const detail = parsed && (parsed.error ?? parsed.message);
    return typeof detail === 'string' ? `: ${detail.slice(0, 120)}` : '';
  } catch {
    return '';
  }
}

/**
 * Send one authentication request without throwing on HTTP status and without
 * following redirects, so neither the API key nor an assertion is ever handed
 * to another host.
 */
async function send(
  http: HttpRequestFn,
  stage: WorkloadAuthStage,
  target: string,
  options: IHttpRequestOptions,
): Promise<FullResponse> {
  try {
    const response = (await http({
      ...options,
      json: false,
      timeout: WORKLOAD_AUTH_TIMEOUT_MS,
      disableFollowRedirect: true,
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
    })) as FullResponse;
    return response;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return fail(stage, `${target} could not be reached (${detail}); no governed request was sent.`);
  }
}

export interface AcquireWorkloadOptions {
  http: HttpRequestFn;
  openboxUrl: string;
  /** Core auth + SDK identity headers (API key, User-Agent, X-OpenBox-SDK-Version). */
  coreHeaders: Record<string, string>;
  privateKeyPem: string;
}

/** One acquisition: bootstrap, then exchange a fresh client assertion for an access token. */
export async function acquireWorkloadAuth(options: AcquireWorkloadOptions): Promise<WorkloadAuthState> {
  const signer = loadRsaPrivateKey(options.privateKeyPem);

  const boot = await send(options.http, 'bootstrap', "OpenBox Core's workload bootstrap endpoint", {
    method: 'GET',
    url: `${options.openboxUrl}${BOOTSTRAP_PATH_V3}`,
    headers: { ...options.coreHeaders, Accept: 'application/json' },
  });
  if (boot.statusCode !== 200) {
    fail(
      'bootstrap',
      `OpenBox Core rejected the workload bootstrap (HTTP ${boot.statusCode}${errorDetail(boot.body)}). ` +
        'Check the API key and that the agent uses Keycloak workload identity.',
    );
  }
  const metadata = parseWorkloadBootstrapDocument(
    parseBody(boot.body, 'Workload bootstrap response', 'bootstrap'),
  );

  // Measured before the exchange, so the token's lifetime is never overestimated.
  const startedAt = Date.now();
  // Exactly these four fields: the OpenBox API key never reaches Keycloak.
  const form = new URLSearchParams([
    ['grant_type', 'client_credentials'],
    ['client_id', metadata.clientId],
    ['client_assertion_type', CLIENT_ASSERTION_TYPE],
    ['client_assertion', buildWorkloadClientAssertion(signer, metadata)],
  ]).toString();
  const tok = await send(options.http, 'token', "Keycloak's token endpoint", {
    method: 'POST',
    url: metadata.tokenEndpoint,
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  if (tok.statusCode !== 200) {
    fail(
      'token',
      `Keycloak rejected the workload token exchange (HTTP ${tok.statusCode}${errorDetail(tok.body)}). ` +
        "Check that the Workload Private Key matches the agent's active workload identity.",
    );
  }
  const grant = parseWorkloadTokenResponse(parseBody(tok.body, 'Keycloak workload token response', 'token'));

  const refreshAtMs = startedAt + (grant.cacheSeconds - ACCESS_TOKEN_REFRESH_MARGIN_SECONDS) * 1000;
  if (Date.now() >= refreshAtMs) {
    fail('token', "The workload token exchange took longer than the token's usable lifetime; no governed request was sent.");
  }
  return { metadata, accessToken: grant.accessToken, refreshAtMs };
}

interface CacheEntry {
  pending: Promise<WorkloadAuthState>;
  /** Set once `pending` resolves. */
  state?: WorkloadAuthState;
}

/** The in-flight or published acquisition, per owner (an n8n execution context). */
const cache = new WeakMap<object, CacheEntry>();

/**
 * A usable workload auth state for `owner`, acquiring one when none is
 * cached or the cached one is refresh-due. Concurrent callers share one
 * acquisition; a failed acquisition is not cached.
 */
export async function getWorkloadAuth(owner: object, options: AcquireWorkloadOptions): Promise<WorkloadAuthState> {
  const entry = cache.get(owner);
  if (entry && (!entry.state || Date.now() < entry.state.refreshAtMs)) return entry.pending;

  const next: CacheEntry = { pending: acquireWorkloadAuth(options) };
  cache.set(owner, next);
  next.pending.then(
    (state) => {
      next.state = state;
    },
    () => {
      if (cache.get(owner) === next) cache.delete(owner);
    },
  );
  return next.pending;
}

/** Drop `state` after Core rejected a request carrying it (no-op if already replaced). */
export function invalidateWorkloadAuth(owner: object, state: WorkloadAuthState): void {
  if (cache.get(owner)?.state === state) cache.delete(owner);
}
