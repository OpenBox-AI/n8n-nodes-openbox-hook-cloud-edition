/**
 * Governance configuration.
 *
 * Mirrors OpenBoxLangChainMiddlewareOptions + GovernanceConfig in middleware.py.
 * The Python SDK has these in separate classes; we merge them here since
 * TypeScript doesn't have dataclasses and the separation adds no value.
 */

export interface OpenBoxLangChainMiddlewareOptions {
  /** Displayed as workflow_type in governance events. Mirrors agent_name param. */
  agentName?: string;
  sessionId?: string;
  /** task_queue field on all events. Defaults to "n8n". Python default: "langchain". */
  taskQueue?: string;
  onApiError?: 'fail_open' | 'fail_closed';
  /** Governance HTTP request timeout, in seconds. Also the source of the request timeout. */
  governanceTimeout?: number;
  /** Maps tool name → tool_type tag sent on ToolStarted/ToolCompleted. */
  toolTypeMap?: Record<string, string>;
  /** Tool names whose governance events are suppressed entirely. */
  skipToolTypes?: Set<string>;
  sendChainStartEvent?: boolean;
  sendChainEndEvent?: boolean;
  sendLlmStartEvent?: boolean;
  sendLlmEndEvent?: boolean;
  sendToolStartEvent?: boolean;
  sendToolEndEvent?: boolean;
  hitl?: Partial<HITLConfig>;
}

export interface HITLConfig {
  enabled: boolean;
  pollIntervalMs: number;
  /** null = poll indefinitely (matches SDK's explicit opt-out). */
  timeoutMs: number | null;
}

export interface GovernanceConfig {
  taskQueue: string;
  onApiError: 'fail_open' | 'fail_closed';
  governanceTimeout: number;
  toolTypeMap: Record<string, string>;
  skipToolTypes: Set<string>;
  sessionId?: string;
  agentName?: string;
  sendChainStartEvent: boolean;
  sendChainEndEvent: boolean;
  sendLlmStartEvent: boolean;
  sendLlmEndEvent: boolean;
  sendToolStartEvent: boolean;
  sendToolEndEvent: boolean;
  hitl: HITLConfig;
}

/**
 * Default HITL max wait — 1 hour, comfortably above the typical server-side
 * approval expiry (~30 min). Matches openbox-langchain-sdk-ts's
 * DEFAULT_APPROVAL_MAX_WAIT_MS. Previously hardcoded to 5 minutes here, which
 * could time out a human approver who was still legitimately working through
 * the request.
 */
export const DEFAULT_APPROVAL_MAX_WAIT_MS = 60 * 60 * 1000;

/** merge_config() — mirrors openbox_langgraph.config.merge_config */
export function mergeConfig(opts: OpenBoxLangChainMiddlewareOptions): GovernanceConfig {
  return {
    taskQueue: opts.taskQueue ?? 'n8n',
    onApiError: opts.onApiError ?? 'fail_open',
    governanceTimeout: opts.governanceTimeout ?? 30.0,
    toolTypeMap: opts.toolTypeMap ?? {},
    skipToolTypes: opts.skipToolTypes ?? new Set(),
    sessionId: opts.sessionId,
    agentName: opts.agentName,
    sendChainStartEvent: opts.sendChainStartEvent ?? true,
    sendChainEndEvent: opts.sendChainEndEvent ?? true,
    sendLlmStartEvent: opts.sendLlmStartEvent ?? true,
    sendLlmEndEvent: opts.sendLlmEndEvent ?? true,
    sendToolStartEvent: opts.sendToolStartEvent ?? true,
    sendToolEndEvent: opts.sendToolEndEvent ?? true,
    hitl: {
      enabled: opts.hitl?.enabled ?? true,
      pollIntervalMs: opts.hitl?.pollIntervalMs ?? 5000,
      timeoutMs: opts.hitl?.timeoutMs !== undefined ? opts.hitl.timeoutMs : DEFAULT_APPROVAL_MAX_WAIT_MS,
    },
  };
}
