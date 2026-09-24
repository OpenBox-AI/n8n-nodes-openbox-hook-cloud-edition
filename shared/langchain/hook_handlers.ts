/**
 * Hook handler functions — TypeScript port of middleware_hook_handlers.py.
 *
 * handle_before_agent / handle_after_agent / handle_wrap_model_call.
 */

import {
  applyPiiRedaction,
  buildEvent,
  evaluate,
  extractLastUserMessage,
  extractPromptFromMessages,
  extractResponseMetadata,
  hasHumanTurn,
  sendOrphanClosure,
  Turn,
} from './hooks';
import { toErrorInfo } from './error-info';
import { pollApprovalOrHalt } from './hitl';
import type { OpenBoxLangChainMiddleware } from './middleware';
import {
  GovernanceVerdictResponse,
  hexId,
  safeSerialize,
} from './types';
import { enforceVerdict, toNodeError } from './verdict';

export interface AgentState {
  messages: unknown[];
  [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════
// handle_before_agent → WorkflowStarted + SignalReceived (enforced)
// ═══════════════════════════════════════════════════════════════════

export async function handleBeforeAgent(
  mw: OpenBoxLangChainMiddleware,
  state: AgentState,
  threadId: string = 'n8n',
): Promise<Turn> {
  const minted = hexId(32);
  const turn: Turn = {
    workflowId: `${threadId}-${minted.slice(0, 8)}`,
    runId: `${threadId}-run-${minted.slice(8, 16)}`,
  };
  mw._client.updateTraceId(turn.workflowId);

  const messages = state.messages ?? [];

  // Everything below can throw (governance block/halt, or a hard API-error
  // failure now that auth/onApiError=fail_closed propagate instead of
  // silently swallowing). turn is minted above and never depends on any of
  // this succeeding, so attach it to any thrown error — the caller
  // (OpenBoxAgent.node.ts) needs it to still call afterAgent()/close the
  // workflow even when beforeAgent itself fails.
  try {
    // WorkflowStarted — identity only. Sent before SignalReceived so Core's
    // event ordering matches actual execution order.
    if (mw._config.sendChainStartEvent) {
      await evaluate(mw, buildEvent(mw, turn, 'WorkflowStarted', `${turn.runId}-wf`, mw._workflowType));
    }

    // SignalReceived — user prompt as trigger. Governed whenever there is a
    // human/user turn at all, regardless of whether the extracted text is
    // empty or multimodal — an empty/non-text first turn must still be
    // governed, not silently skipped.
    if (hasHumanTurn(messages)) {
      const userPrompt = extractLastUserMessage(messages) ?? '';
      const sigActivityId = `${turn.runId}-sig`;
      const response = await evaluate(mw, buildEvent(mw, turn, 'SignalReceived', sigActivityId, 'user_prompt', {
        signal_name: 'user_prompt',
        signal_args: [userPrompt],
      }));

      if (response != null) {
        try {
          const result = enforceVerdict(mw._node, response, 'signal_received');
          if (result.requiresHitl) {
            await pollApprovalOrHalt(mw, turn, sigActivityId, 'user_prompt', result.approvalId);
          }
        } catch (err) {
          await sendOrphanClosure(mw, turn, 'ActivityCompleted', sigActivityId, 'user_prompt', err);
          throw toNodeError(mw._node, err);
        }
      }
    }

    // LLMStarted pre-screen is intentionally deferred to handleWrapModelCall.
    // Sending LLMStarted here (before memory_load) would anchor the llm_call
    // activity to the before_agent timestamp, causing Core to display it before
    // the memory_load activity even though the model call happens after.
    // wrapModelCall sends LLMStarted at the correct time (after memory is loaded),
    // so all events arrive at Core in true execution order.
    return turn;
  } catch (err) {
    const nodeError = toNodeError(mw._node, err);
    (nodeError as unknown as Record<string, unknown>).__obTurn = turn;
    throw nodeError;
  }
}

// ═══════════════════════════════════════════════════════════════════
// handle_after_agent → WorkflowCompleted
// ═══════════════════════════════════════════════════════════════════

export async function handleAfterAgent(
  mw: OpenBoxLangChainMiddleware,
  turn: Turn,
  state: AgentState,
  failedWith?: Error,
): Promise<GovernanceVerdictResponse | null> {
  if (!mw._config.sendChainEndEvent) return null;

  const messages = state.messages ?? [];
  let lastContent: unknown = null;
  if (messages.length > 0) {
    const lastMsg = messages[messages.length - 1] as Record<string, unknown>;
    lastContent = lastMsg?.content ?? null;
  }

  const verdict = await evaluate(mw, buildEvent(mw, turn, 'WorkflowCompleted', `${turn.runId}-wf`, mw._workflowType, {
    workflow_output: safeSerialize({ result: lastContent }),
    status: failedWith ? 'failed' : 'completed',
    ...(failedWith ? { error: toErrorInfo(failedWith) } : {}),
  }));

  return verdict;
}

// ═══════════════════════════════════════════════════════════════════
// handle_wrap_model_call → LLMStarted → PII redact → Model → LLMCompleted
// ═══════════════════════════════════════════════════════════════════

export async function handleWrapModelCall(
  mw: OpenBoxLangChainMiddleware,
  turn: Turn,
  messages: unknown[],
  handler: () => Promise<unknown>,
): Promise<unknown> {
  // Use only the last human message as the governed prompt — extractPromptFromMessages
  // would join ALL human messages including chat history loaded from memory, producing
  // a concatenated blob of prior turns instead of the current user input.
  const promptText = extractLastUserMessage(messages) ?? extractPromptFromMessages(messages);

  const activityId = hexId(32);
  let startResponse: GovernanceVerdictResponse | null;
  const startMs = Date.now();
  // Set when LLMStarted required, and received, human approval — LLMCompleted
  // is then not evaluated, to avoid a spurious second approval on Core.
  let llmWasApproved = false;

  if (mw._config.sendLlmStartEvent) {
    startResponse = await evaluate(mw, buildEvent(mw, turn, 'LLMStarted', activityId, 'llm_call', {
      activity_input: [{ prompt: promptText }],
      prompt: promptText,
    }));
  } else {
    startResponse = null;
  }

  // PII redaction — only apply when the returned text is a valid, non-null
  // coercion of Core's redacted_input. Redaction removes/replaces content; it
  // never expands it arbitrarily, so no length heuristic is applied here —
  // that heuristic previously caused legitimate (longer) redactions to be
  // silently skipped, leaking the raw prompt to the model provider.
  const guardrails = startResponse?.guardrails_result ?? startResponse?.guardrailsResult;
  if (guardrails?.input_type === 'activity_input' && guardrails.redacted_input != null) {
    applyPiiRedaction(messages, guardrails.redacted_input);
  }

  // Enforce LLMStarted verdict (block/halt throw; require_approval polls).
  // On a hard block/halt, close the orphaned llm_call row before rethrowing —
  // otherwise it's a "started, never completed" row on Core forever.
  if (startResponse != null) {
    try {
      const result = enforceVerdict(mw._node, startResponse, 'llm_start');
      if (result.requiresHitl) {
        await pollApprovalOrHalt(mw, turn, activityId, 'llm_call', result.approvalId);
        llmWasApproved = true;
      }
    } catch (err) {
      if (mw._config.sendLlmEndEvent) {
        await sendOrphanClosure(mw, turn, 'LLMCompleted', activityId, 'llm_call', err);
      }
      throw toNodeError(mw._node, err);
    }
  }

  let modelResponse: unknown;
  try {
    modelResponse = await handler();
  } catch (err) {
    // A model-call failure — close the llm_call row instead of leaving it
    // orphaned on Core.
    if (mw._config.sendLlmEndEvent) {
      await sendOrphanClosure(mw, turn, 'LLMCompleted', activityId, 'llm_call', err);
    }
    throw toNodeError(mw._node, err);
  }
  const endMs = Date.now();
  const duration_ms = endMs - startMs;

  // LLMCompleted — skip evaluate entirely when already approved to avoid
  // spurious approval requests on Core for the same activity_type. Reuses
  // the SAME activityId as LLMStarted — Core matches completions to starts
  // by activity_id; a different id produces an orphan Core discards.
  if (mw._config.sendLlmEndEvent && !llmWasApproved) {
    const meta = extractResponseMetadata(modelResponse);
    const resp = await evaluate(mw, buildEvent(mw, turn, 'LLMCompleted', activityId, 'llm_call', {
      status: 'completed',
      duration_ms,
      llm_model: meta.llm_model,
      input_tokens: meta.input_tokens,
      output_tokens: meta.output_tokens,
      total_tokens: meta.total_tokens,
      has_tool_calls: meta.has_tool_calls,
      completion: meta.completion,
    }));

    if (resp != null) {
      const endResult = enforceVerdict(mw._node, resp, 'llm_end');
      if (endResult.requiresHitl) {
        await pollApprovalOrHalt(mw, turn, activityId, 'llm_call', endResult.approvalId);
      }
    }
  }

  return modelResponse;
}

// ═══════════════════════════════════════════════════════════════════
// handle_wrap_memory_op → memory load/save as its own activity, so it
// shows on Core's timeline in execution order.
// ═══════════════════════════════════════════════════════════════════

export async function handleWrapMemoryOp<T>(
  mw: OpenBoxLangChainMiddleware,
  turn: Turn,
  opType: 'load_memory' | 'save_context',
  fn: () => Promise<T>,
): Promise<T> {
  const activityId = hexId(32);
  const startMs = Date.now();

  try {
    await evaluate(mw, buildEvent(mw, turn, 'ActivityStarted', activityId, opType));
  } catch { /* non-fatal */ }

  // Capture result so ActivityCompleted can include activity_output.
  // The Python SDK (activity_interceptor._send_activity_event) uses the same
  // activity_id for both ActivityStarted and ActivityCompleted. Core matches
  // completions to their starts by activity_id; a different id (e.g. '-c' suffix)
  // produces an orphan that Core discards — the dashboard shows "started, never ended".
  // When fn() throws (e.g. Postgres error), the Python SDK never calls
  // _handle_completion (Temporal runtime tracks the failure). In n8n we have no
  // runtime, so we always send ActivityCompleted from finally — with the correct id.
  let status: 'completed' | 'failed' = 'completed';
  let errorInfo: ReturnType<typeof toErrorInfo> | undefined;
  let result: T | undefined;
  try {
    result = await fn();
    return result;
  } catch (err) {
    status = 'failed';
    errorInfo = toErrorInfo(err);
    throw toNodeError(mw._node, err);
  } finally {
    const completedEvent = buildEvent(mw, turn, 'ActivityCompleted', activityId, opType, {
      status,
      duration_ms: Date.now() - startMs,
      activity_output: status === 'completed' ? safeSerialize(result) : null,
      spans: [],
      span_count: 0,
      ...(errorInfo ? { error: errorInfo } : {}),
    });
    // Await ActivityCompleted so it arrives at Core before the caller proceeds
    // to the next lifecycle event (e.g. LLMStarted). Matches Python SDK's
    // sequential await pattern — all events must be strictly ordered by arrival.
    try {
      await evaluate(mw, completedEvent);
    } catch { /* non-fatal */ }
  }
}
