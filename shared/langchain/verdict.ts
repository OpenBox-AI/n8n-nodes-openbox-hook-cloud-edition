/**
 * Verdict enforcement — TypeScript port of openbox_langgraph/verdict_handler.py.
 *
 * enforce_verdict() maps governance verdict arms to exceptions.
 */

import { INode, NodeApiError, NodeOperationError } from 'n8n-workflow';

import { GovernanceVerdictResponse, VerdictArm } from './types';

// Governance outcomes are NodeOperationErrors, so they reach n8n as proper
// node errors and survive being passed back through toNodeError() unchanged
// (NodeOperationError's constructor returns an existing instance as-is).

export class GovernanceHaltError extends NodeOperationError {
  constructor(node: INode, message: string) {
    super(node, message);
    this.name = 'GovernanceHaltError';
    this.message = message;
  }
}

export class GovernanceBlockedError extends NodeOperationError {
  verdict: VerdictArm;
  constructor(node: INode, verdict: VerdictArm, message: string) {
    super(node, message);
    this.name = 'GovernanceBlockedError';
    this.message = message;
    this.verdict = verdict;
  }
}

export class GuardrailsValidationError extends NodeOperationError {
  reasons: string[];
  constructor(node: INode, reasons: string[]) {
    const message = reasons.length > 0 ? reasons.join('; ') : 'Guardrails validation failed';
    super(node, message);
    this.name = 'GuardrailsValidationError';
    this.message = message;
    this.reasons = reasons;
  }
}

/**
 * Normalise anything caught on its way back to n8n into a node error. OpenBox
 * API failures are already NodeApiErrors and governance outcomes are already
 * NodeOperationErrors — both pass through untouched, so callers can still
 * tell them apart. Anything else (a model provider or tool failure) is
 * wrapped in a NodeOperationError carrying its message.
 */
export function toNodeError(node: INode, err: unknown): NodeApiError | NodeOperationError {
  if (err instanceof NodeApiError || err instanceof NodeOperationError) return err;
  return new NodeOperationError(node, err instanceof Error ? err : String(err));
}

/**
 * Format the "a human rejected this activity" message. Previously each poll
 * loop built this inline as `Activity rejected: ${response.reason ?? 'Activity
 * rejected'}`, which — whenever Core didn't send a reason — produced the
 * redundant "Activity rejected: Activity rejected".
 */
export function formatActivityRejectedMessage(reason?: string | null): string {
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  return trimmed ? `Activity rejected: ${trimmed}` : 'Activity rejected (no reason provided)';
}

export interface VerdictResult {
  /** True when arm === 'require_approval' and the caller should poll. */
  requiresHitl: boolean;
  /** Core-assigned approval ID — use this for polling, not the local activityId. */
  approvalId?: string;
}

/**
 * enforce_verdict(response, phase) — direct port.
 *
 * Throws GovernanceHaltError/GovernanceBlockedError on halt/block.
 * Returns VerdictResult({ requiresHitl: true }) on require_approval.
 * Returns VerdictResult({ requiresHitl: false }) on allow/monitor/constrain.
 */
export function enforceVerdict(
  node: INode,
  response: GovernanceVerdictResponse,
  phase: string,
): VerdictResult {
  const arm = verdictFromString(response.arm ?? response.verdict);

  if (arm === 'halt') {
    throw new GovernanceHaltError(
      node,
      `OpenBox governance halt at ${phase}: ${response.reason ?? 'halted by policy'}`,
    );
  }
  if (arm === 'block') {
    throw new GovernanceBlockedError(
      node,
      'block',
      `OpenBox governance block at ${phase}: ${response.reason ?? 'blocked by policy'}`,
    );
  }

  const guardrails = response.guardrails_result ?? response.guardrailsResult;
  if (guardrails && guardrails.validation_passed === false) {
    const reasons = Array.isArray(guardrails.reasons)
      ? guardrails.reasons
        .map((r) => r.reason)
        .filter((r): r is string => typeof r === 'string' && r.length > 0)
      : [];
    throw new GuardrailsValidationError(node, reasons);
  }

  if (arm === 'require_approval') {
    const approvalId = response.approval_id ?? response.approvalId ?? response.id;
    return { requiresHitl: true, approvalId };
  }

  return { requiresHitl: false };
}

export function verdictFromString(value: unknown): VerdictArm {
  if (typeof value !== 'string') return 'allow';
  const normalized = value.toLowerCase().replace(/-/g, '_');
  if (normalized === 'continue') return 'allow';
  if (normalized === 'stop') return 'halt';
  if (normalized === 'request_approval') return 'require_approval';
  if (
    normalized === 'allow' ||
    normalized === 'monitor' ||
    normalized === 'constrain' ||
    normalized === 'block' ||
    normalized === 'halt' ||
    normalized === 'require_approval'
  ) {
    return normalized;
  }
  return 'allow';
}
