"use strict";
/**
 * Tool governance hook — TypeScript port of middleware_tool_hook.py.
 *
 * handle_wrap_tool_call: ToolStarted → execute tool → ToolCompleted.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleWrapToolCall = handleWrapToolCall;
const hooks_1 = require("./hooks");
const error_info_1 = require("./error-info");
const hitl_1 = require("./hitl");
const types_1 = require("./types");
const verdict_1 = require("./verdict");
async function handleWrapToolCall(mw, turn, toolName, toolArgs, handler) {
    // Skip governance for excluded tools (mirrors skip_tool_types config)
    if (mw._config.skipToolTypes.has(toolName)) {
        return handler();
    }
    const activityId = (0, types_1.hexId)(32);
    const toolType = mw._config.toolTypeMap[toolName];
    const startMs = Date.now();
    // Set when ToolStarted required, and received, human approval. One approval
    // covers the whole tool execution, so the ToolCompleted verdict is not
    // enforced again (that would create a second approval row on Core).
    let wasApproved = false;
    // ── ToolStarted ──────────────────────────────────────────────────────────────
    if (mw._config.sendToolStartEvent) {
        const response = await (0, hooks_1.evaluate)(mw, (0, hooks_1.buildEvent)(mw, turn, 'ToolStarted', activityId, toolName, {
            activity_input: [(0, types_1.safeSerialize)(toolArgs)],
            tool_name: toolName,
            tool_type: toolType,
        }));
        if (response != null) {
            try {
                const result = (0, verdict_1.enforceVerdict)(mw._node, response, 'tool_start');
                if (result.requiresHitl) {
                    await (0, hitl_1.pollApprovalOrHalt)(mw, turn, activityId, toolName, result.approvalId);
                    wasApproved = true;
                }
            }
            catch (err) {
                // A hard block/halt at tool-start previously threw here with no
                // completion event sent at all — a true orphan on Core. Close it
                // with the same activity id before rethrowing.
                if (mw._config.sendToolEndEvent) {
                    await (0, hooks_1.sendOrphanClosure)(mw, turn, 'ToolCompleted', activityId, toolName, err);
                }
                throw (0, verdict_1.toNodeError)(mw._node, err);
            }
        }
    }
    // ── Execute tool ─────────────────────────────────────────────────────────────
    let toolResult;
    try {
        toolResult = await handler();
    }
    catch (err) {
        if (mw._config.sendToolEndEvent && !wasApproved) {
            await (0, hooks_1.evaluate)(mw, (0, hooks_1.buildEvent)(mw, turn, 'ToolCompleted', activityId, toolName, {
                activity_output: (0, types_1.safeSerialize)({ error: (0, error_info_1.toErrorInfo)(err) }),
                tool_name: toolName,
                tool_type: toolType,
                status: 'failed',
                duration_ms: Date.now() - startMs,
                error: (0, error_info_1.toErrorInfo)(err),
            }));
        }
        throw (0, verdict_1.toNodeError)(mw._node, err);
    }
    const endMs = Date.now();
    const duration_ms = endMs - startMs;
    // ── ToolCompleted ─────────────────────────────────────────────────────────────
    if (mw._config.sendToolEndEvent) {
        // String results wrapped as {result: ...}, non-strings serialized directly
        const serializedOutput = typeof toolResult === 'string'
            ? (0, types_1.safeSerialize)({ result: toolResult })
            : (0, types_1.safeSerialize)(toolResult);
        // Always send ToolCompleted so Core can show the completion on the dashboard.
        // Reuses the SAME activityId as ToolStarted — Core matches completions to
        // starts by activity_id; a different id produces an orphan Core discards.
        // When wasApproved=true (ToolStarted already required+received human approval),
        // send the event but skip verdict enforcement — enforcing it would trigger a
        // second governance evaluation and create a spurious approval row on Core.
        const resp = await (0, hooks_1.evaluate)(mw, (0, hooks_1.buildEvent)(mw, turn, 'ToolCompleted', activityId, toolName, {
            activity_output: serializedOutput,
            tool_name: toolName,
            tool_type: toolType,
            status: 'completed',
            duration_ms,
        }));
        if (resp != null && !wasApproved) {
            const result = (0, verdict_1.enforceVerdict)(mw._node, resp, 'tool_end');
            if (result.requiresHitl) {
                await (0, hitl_1.pollApprovalOrHalt)(mw, turn, activityId, toolName, result.approvalId);
            }
        }
    }
    return toolResult;
}
