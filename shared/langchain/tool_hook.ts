/**
 * Tool governance hook — TypeScript port of middleware_tool_hook.py.
 *
 * handle_wrap_tool_call: ToolStarted → execute tool → ToolCompleted.
 */

import { buildEvent, evaluate, sendOrphanClosure, Turn } from './hooks';
import { toErrorInfo } from './error-info';
import { pollApprovalOrHalt } from './hitl';
import type { OpenBoxLangChainMiddleware } from './middleware';
import { hexId, safeSerialize } from './types';
import { enforceVerdict, toNodeError } from './verdict';

export async function handleWrapToolCall(
  mw: OpenBoxLangChainMiddleware,
  turn: Turn,
  toolName: string,
  toolArgs: unknown,
  handler: () => Promise<unknown>,
): Promise<unknown> {
  // Skip governance for excluded tools (mirrors skip_tool_types config)
  if (mw._config.skipToolTypes.has(toolName)) {
    return handler();
  }

  const activityId = hexId(32);
  const toolType = mw._config.toolTypeMap[toolName];
  const startMs = Date.now();
  // Set when ToolStarted required, and received, human approval. One approval
  // covers the whole tool execution, so the ToolCompleted verdict is not
  // enforced again (that would create a second approval row on Core).
  let wasApproved = false;

  // ── ToolStarted ──────────────────────────────────────────────────────────────
  if (mw._config.sendToolStartEvent) {
    const response = await evaluate(mw, buildEvent(mw, turn, 'ToolStarted', activityId, toolName, {
      activity_input: [safeSerialize(toolArgs)],
      tool_name: toolName,
      tool_type: toolType,
    }));

    if (response != null) {
      try {
        const result = enforceVerdict(mw._node, response, 'tool_start');
        if (result.requiresHitl) {
          await pollApprovalOrHalt(mw, turn, activityId, toolName, result.approvalId);
          wasApproved = true;
        }
      } catch (err) {
        // A hard block/halt at tool-start previously threw here with no
        // completion event sent at all — a true orphan on Core. Close it
        // with the same activity id before rethrowing.
        if (mw._config.sendToolEndEvent) {
          await sendOrphanClosure(mw, turn, 'ToolCompleted', activityId, toolName, err);
        }
        throw toNodeError(mw._node, err);
      }
    }
  }

  // ── Execute tool ─────────────────────────────────────────────────────────────
  let toolResult: unknown;
  try {
    toolResult = await handler();
  } catch (err) {
    if (mw._config.sendToolEndEvent && !wasApproved) {
      await evaluate(mw, buildEvent(mw, turn, 'ToolCompleted', activityId, toolName, {
        activity_output: safeSerialize({ error: toErrorInfo(err) }),
        tool_name: toolName,
        tool_type: toolType,
        status: 'failed',
        duration_ms: Date.now() - startMs,
        error: toErrorInfo(err),
      }));
    }
    throw toNodeError(mw._node, err);
  }

  const endMs = Date.now();
  const duration_ms = endMs - startMs;

  // ── ToolCompleted ─────────────────────────────────────────────────────────────
  if (mw._config.sendToolEndEvent) {
    // String results wrapped as {result: ...}, non-strings serialized directly
    const serializedOutput =
      typeof toolResult === 'string'
        ? safeSerialize({ result: toolResult })
        : safeSerialize(toolResult);

    // Always send ToolCompleted so Core can show the completion on the dashboard.
    // Reuses the SAME activityId as ToolStarted — Core matches completions to
    // starts by activity_id; a different id produces an orphan Core discards.
    // When wasApproved=true (ToolStarted already required+received human approval),
    // send the event but skip verdict enforcement — enforcing it would trigger a
    // second governance evaluation and create a spurious approval row on Core.
    const resp = await evaluate(mw, buildEvent(mw, turn, 'ToolCompleted', activityId, toolName, {
      activity_output: serializedOutput,
      tool_name: toolName,
      tool_type: toolType,
      status: 'completed',
      duration_ms,
    }));

    if (resp != null && !wasApproved) {
      const result = enforceVerdict(mw._node, resp, 'tool_end');
      if (result.requiresHitl) {
        await pollApprovalOrHalt(mw, turn, activityId, toolName, result.approvalId);
      }
    }
  }

  return toolResult;
}
