"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pollApprovalOrHalt = pollApprovalOrHalt;
const n8n_workflow_1 = require("n8n-workflow");
const verdict_1 = require("./verdict");
async function pollApprovalOrHalt(mw, turn, activityId, activityType, approvalId) {
    if (!mw._config.hitl.enabled) {
        throw new verdict_1.GovernanceHaltError(mw._node, `Approval required for activity ${activityType}`);
    }
    const timeoutMs = mw._config.hitl.timeoutMs;
    const startedAt = Date.now();
    while (timeoutMs == null || Date.now() - startedAt <= timeoutMs) {
        const response = await mw._client.pollApproval(turn.workflowId, turn.runId, activityId, approvalId, mw._config.onApiError);
        if (response == null) {
            await (0, n8n_workflow_1.sleep)(mw._config.hitl.pollIntervalMs);
            continue;
        }
        if (response.expired) {
            throw new verdict_1.GovernanceHaltError(mw._node, `Approval expired for activity ${activityType} (workflow_id=${turn.workflowId}, run_id=${turn.runId}, activity_id=${activityId})`);
        }
        // A response body with no arm/verdict/action field at all means Core
        // hasn't recorded a human decision yet (still pending) — NOT "allow".
        // verdictFromString(undefined) defaults to 'allow' (the correct default
        // for the initial governance-evaluate response, where an unset field
        // means "no restriction stated"), but reusing that default here would
        // resolve the poll loop on its very first tick, before anyone approved
        // anything. Only interpret a verdict once Core actually sent one.
        const rawVerdict = response.arm ?? response.verdict ?? response.action;
        if (typeof rawVerdict !== 'string' || rawVerdict.trim() === '') {
            await (0, n8n_workflow_1.sleep)(mw._config.hitl.pollIntervalMs);
            continue;
        }
        const verdict = (0, verdict_1.verdictFromString)(rawVerdict);
        if (verdict === 'allow')
            return;
        if (verdict === 'block' || verdict === 'halt') {
            throw new verdict_1.GovernanceHaltError(mw._node, (0, verdict_1.formatActivityRejectedMessage)(response.reason));
        }
        await (0, n8n_workflow_1.sleep)(mw._config.hitl.pollIntervalMs);
    }
    throw new verdict_1.GovernanceHaltError(mw._node, `Approval timed out for activity ${activityType} (workflow_id=${turn.workflowId}, run_id=${turn.runId}, activity_id=${activityId})`);
}
