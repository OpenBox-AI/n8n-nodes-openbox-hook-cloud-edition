import {
  IAuthenticate,
  ICredentialDataDecryptedObject,
  ICredentialTestRequest,
  ICredentialType,
  IHttpRequestOptions,
  INodeProperties,
} from 'n8n-workflow';

import { buildSignedHeaders } from '../shared/signing';

const DEFAULT_OPENBOX_URL = 'https://core.openbox.ai';

export class OpenBoxApi implements ICredentialType {
  name = 'openBoxApi';
  displayName = 'OpenBox API';
  documentationUrl = 'https://docs.openbox.ai/integrations/n8n';
  icon = { light: 'file:openbox.svg', dark: 'file:openbox.dark.svg' } as const;

  properties: INodeProperties[] = [
    {
      displayName: 'API Base URL',
      name: 'openboxUrl',
      type: 'string',
      default: DEFAULT_OPENBOX_URL,
      description:
        'OpenBox Core API base URL. Leave as default unless running a self-hosted Core instance.',
    },
    {
      displayName: 'API Key',
      name: 'apiKey',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      required: true,
      description:
        'Agent API key issued by OpenBox. Live keys start with "obx_live_"; test keys with "obx_test_".',
    },
    {
      displayName: 'Agent DID',
      name: 'agentDid',
      type: 'string',
      default: '',
      description:
        'Optional. Agent decentralized identifier (format: did:aip:<uuid>). Required for agents with signing_required=true. Pair with Agent Private Key.',
      placeholder: 'did:aip:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
    },
    {
      displayName: 'Agent Private Key',
      name: 'agentPrivateKey',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      description:
        'Optional. Base64-encoded raw 32-byte Ed25519 seed. Every request is signed locally with this key. Required for agents with signing_required=true. Pair with Agent DID.',
    },
    {
      displayName: 'Workload Private Key',
      name: 'workloadPrivateKey',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      description:
        'Optional. PKCS8 PEM RSA private key of the agent\'s Keycloak workload identity (IAM v3). When set, every request goes to /api/v3 with a short-lived workload token. Leave Agent DID and Agent Private Key empty.',
      placeholder: '-----BEGIN PRIVATE KEY----- ... -----END PRIVATE KEY-----',
    },
  ];

  test: ICredentialTestRequest = {
    request: {
      baseURL: '={{$credentials.openboxUrl || "' + DEFAULT_OPENBOX_URL + '"}}',
      url: '/api/v1/auth/validate',
      method: 'GET',
    },
  };

  authenticate: IAuthenticate = async (
    credentials: ICredentialDataDecryptedObject,
    requestOptions: IHttpRequestOptions,
  ): Promise<IHttpRequestOptions> => {
    const apiKey = String(credentials.apiKey ?? '');
    const agentDid = credentials.agentDid ? String(credentials.agentDid) : undefined;
    const agentPrivateKey = credentials.agentPrivateKey ? String(credentials.agentPrivateKey) : undefined;

    // Extract the path for signing; url may be relative or absolute.
    const rawUrl = requestOptions.url ?? '';
    let path: string;
    try {
      path = rawUrl.startsWith('http') ? new URL(rawUrl).pathname : rawUrl;
    } catch {
      path = rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`;
    }

    const headers = buildSignedHeaders(
      String(requestOptions.method ?? 'GET'),
      path,
      Buffer.alloc(0),
      apiKey,
      agentDid,
      agentPrivateKey,
    );

    return { ...requestOptions, headers: { ...requestOptions.headers, ...headers } };
  };
}

export interface OpenBoxCredentials {
  openboxUrl: string;
  apiKey: string;
  agentDid?: string;
  agentPrivateKey?: string;
  /** PKCS8 PEM RSA key; selects IAM v3 workload authentication. */
  workloadPrivateKey?: string;
}

export function normalizeOpenBoxCredentials(
  raw: ICredentialDataDecryptedObject,
): OpenBoxCredentials {
  const apiKey = String(raw.apiKey ?? '').trim();
  if (!apiKey) {
    throw new Error('OpenBox credential is missing the API key.');
  }

  const rawUrl = raw.openboxUrl ? String(raw.openboxUrl).trim().replace(/\/+$/, '') : '';

  const agentDid = raw.agentDid ? String(raw.agentDid) : undefined;
  const agentPrivateKey = raw.agentPrivateKey ? String(raw.agentPrivateKey) : undefined;
  const workloadPrivateKey = String(raw.workloadPrivateKey ?? '').trim() || undefined;
  // A workload key fixes the credential to IAM v3; mixing it with DID signing
  // would leave it ambiguous which identity Core should verify.
  if (workloadPrivateKey && (agentDid || agentPrivateKey)) {
    throw new Error(
      'OpenBox credential sets both a Workload Private Key and Agent DID signing. Use one identity method: clear Agent DID and Agent Private Key for a workload-identity agent.',
    );
  }

  return {
    openboxUrl: rawUrl || DEFAULT_OPENBOX_URL,
    apiKey,
    agentDid,
    agentPrivateKey,
    workloadPrivateKey,
  };
}
