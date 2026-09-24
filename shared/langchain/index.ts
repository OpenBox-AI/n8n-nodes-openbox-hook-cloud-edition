/**
 * OpenBox LangChain SDK — TypeScript port.
 *
 * Public surface mirrors openbox_langchain/__init__.py.
 */

export { GovernanceClient, OnApiError } from './client';
export {
  DEFAULT_APPROVAL_MAX_WAIT_MS,
  GovernanceConfig,
  HITLConfig,
  OpenBoxLangChainMiddlewareOptions,
  mergeConfig,
} from './config';
export { AgentState, handleAfterAgent, handleBeforeAgent, handleWrapMemoryOp, handleWrapModelCall } from './hook_handlers';
export {
  applyPiiRedaction,
  baseEventFields,
  buildEvent,
  evaluate,
  extractLastUserMessage,
  extractPromptFromMessages,
  extractResponseMetadata,
  hasHumanTurn,
  sendOrphanClosure,
  Turn,
  turnFromError,
} from './hooks';
export { safeString, toErrorInfo } from './error-info';
export { pollApprovalOrHalt } from './hitl';
export { OpenBoxLangChainMiddleware } from './middleware';
export { handleWrapToolCall } from './tool_hook';
export {
  GovernanceHaltError,
  GovernanceBlockedError,
  GuardrailsValidationError,
  VerdictResult,
  enforceVerdict,
  verdictFromString,
} from './verdict';
export {
  ErrorInfo,
  GovernanceVerdictResponse,
  GuardrailsResult,
  LangChainGovernanceEvent,
  VerdictArm,
  hexId,
  rfc3339Now,
  safeSerialize,
} from './types';
