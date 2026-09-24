/**
 * OpenBoxLangChainMiddleware — TypeScript port of middleware.py.
 *
 * The Python SDK subclasses AgentMiddleware; here we expose the same four
 * lifecycle methods (beforeAgent / afterAgent / wrapModelCall / wrapToolCall)
 * as plain async functions the node calls directly since n8n has no middleware
 * hook infrastructure.
 *
 * Turn identity (workflowId/runId) is NEVER stored as mutable state on this
 * instance — beforeAgent() returns a `Turn` value that the caller threads
 * through every subsequent call. This mirrors openbox-langchain-sdk-ts's
 * turn-state.ts design: identity that lives on a shared/reused instance is
 * exactly the kind of state a future concurrent-execution refactor could
 * accidentally clobber.
 */

import { IExecuteFunctions, INode } from 'n8n-workflow';

import { GovernanceClient } from './client';
import { GovernanceConfig, OpenBoxLangChainMiddlewareOptions, mergeConfig } from './config';
import { Turn } from './hooks';
import { AgentState, handleAfterAgent, handleBeforeAgent, handleWrapMemoryOp, handleWrapModelCall } from './hook_handlers';
import { handleWrapToolCall } from './tool_hook';
import { GovernanceVerdictResponse } from './types';

export class OpenBoxLangChainMiddleware {
  readonly _workflowType: string;

  readonly _config: GovernanceConfig;
  readonly _client: GovernanceClient;
  /** The executing node — governance errors are raised against it. */
  readonly _node: INode;

  constructor(
    options: OpenBoxLangChainMiddlewareOptions,
    executeFunctions: IExecuteFunctions,
  ) {
    this._config = mergeConfig(options);
    this._workflowType = options.agentName ?? 'LangChainRun';
    this._node = executeFunctions.getNode();
    this._client = new GovernanceClient(executeFunctions, '', this._config.governanceTimeout * 1000);
  }

  // ── Lifecycle hooks ────────────────────────────────────────────────────────

  /**
   * before_agent() — session setup.
   * threadId replaces Python's runtime.config.configurable.thread_id.
   * Returns the minted turn identity — pass it to every subsequent call.
   */
  async beforeAgent(state: AgentState, threadId?: string): Promise<Turn> {
    return handleBeforeAgent(this, state, threadId);
  }

  /** after_agent() — session close. Returns the WorkflowCompleted verdict. */
  async afterAgent(turn: Turn, state: AgentState, failedWith?: Error): Promise<GovernanceVerdictResponse | null> {
    return handleAfterAgent(this, turn, state, failedWith);
  }

  /**
   * wrap_model_call() — LLM governance.
   * messages is the full array passed to model.invoke().
   * handler is the thunk that performs the actual model call.
   */
  async wrapModelCall(
    turn: Turn,
    messages: unknown[],
    handler: () => Promise<unknown>,
  ): Promise<unknown> {
    return handleWrapModelCall(this, turn, messages, handler);
  }

  /**
   * wrap_tool_call() — tool governance.
   * In the Python SDK the full ToolCallRequest is passed; here we decompose
   * it so the node doesn't need to construct the LangChain request object.
   */
  async wrapToolCall(
    turn: Turn,
    toolName: string,
    toolArgs: unknown,
    handler: () => Promise<unknown>,
  ): Promise<unknown> {
    return handleWrapToolCall(this, turn, toolName, toolArgs, handler);
  }

  /**
   * wrap_memory_op() — report a memory load/save as its own short-lived
   * activity, so it appears on the OpenBox timeline in execution order.
   */
  async wrapMemoryOp<T>(turn: Turn, opType: 'load_memory' | 'save_context', fn: () => Promise<T>): Promise<T> {
    return handleWrapMemoryOp(this, turn, opType, fn);
  }
}
