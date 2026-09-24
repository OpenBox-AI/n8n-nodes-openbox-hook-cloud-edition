"use strict";
/**
 * Governance configuration.
 *
 * Mirrors OpenBoxLangChainMiddlewareOptions + GovernanceConfig in middleware.py.
 * The Python SDK has these in separate classes; we merge them here since
 * TypeScript doesn't have dataclasses and the separation adds no value.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_APPROVAL_MAX_WAIT_MS = void 0;
exports.mergeConfig = mergeConfig;
/**
 * Default HITL max wait — 1 hour, comfortably above the typical server-side
 * approval expiry (~30 min). Matches openbox-langchain-sdk-ts's
 * DEFAULT_APPROVAL_MAX_WAIT_MS. Previously hardcoded to 5 minutes here, which
 * could time out a human approver who was still legitimately working through
 * the request.
 */
exports.DEFAULT_APPROVAL_MAX_WAIT_MS = 60 * 60 * 1000;
/** merge_config() — mirrors openbox_langgraph.config.merge_config */
function mergeConfig(opts) {
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
            timeoutMs: opts.hitl?.timeoutMs !== undefined ? opts.hitl.timeoutMs : exports.DEFAULT_APPROVAL_MAX_WAIT_MS,
        },
    };
}
