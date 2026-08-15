/**
 * Two-phase DeepSeek Minimal-mode extension for Pi.
 *
 * Only model ids containing `deepseek-v4-flash` or `deepseek-v4-pro` are
 * affected. For those models:
 *
 *   - Every request's system prompt is replaced with the byte-stable DeepSeek
 *     Harness Minimal persona. The prompt never changes for target models.
 *   - The first request's provider tool catalog is narrowed to `bash` and
 *     `read`, matching the Minimal harness tool surface.
 *   - After the first durable assistant turn (text reply or tool call), the
 *     extension stops filtering and exposes Pi's full active tool catalog.
 *     The Minimal prompt is retained.
 *
 * Non-target models are completely untouched: their system prompt, tool
 * catalog, and active-tool state are never modified.
 *
 * @typedef {import("@earendil-works/pi-coding-agent").ExtensionAPI} ExtensionAPI
 */

import {
  MINIMAL_SYSTEM_PROMPT,
  filterBootstrapToolDefinitions,
  hasPromotionSignal,
  isTargetModelId,
} from "../lib/core.js";

const SHELL_TOOLS = ["bash"];
const COMMON_TOOLS = ["read"];
const BOOTSTRAP_TOOLS = new Set([...SHELL_TOOLS, ...COMMON_TOOLS]);

/** @param {ExtensionAPI} pi */
export default function dsMinimalMode(pi) {
  let ready = false;
  let promoted = false;
  let warned = false;
  let inspectedEntryCount = 0;
  let agentRunActive = false;

  const warnOnce = (ctx, message) => {
    if (warned) return;
    warned = true;
    if (ctx?.hasUI) ctx.ui.notify(message, "warning");
    else console.warn(message);
  };

  const resetRuntimeState = () => {
    ready = false;
    promoted = false;
    warned = false;
    inspectedEntryCount = 0;
    agentRunActive = false;
  };

  const activateForTargetModel = (ctx) => {
    resetRuntimeState();
    try {
      const entries = ctx.sessionManager.getEntries();
      promoted = hasPromotionSignal(entries);
      inspectedEntryCount = entries.length;
    } catch {
      promoted = true;
      warnOnce(ctx, "pi-ds-minimal-mode: session state inspection failed; full catalog exposed");
    }
    ready = true;
  };

  const syncTargetModel = (ctx) => {
    if (!isTargetModelId(ctx.model?.id)) {
      resetRuntimeState();
      return false;
    }
    if (!ready) activateForTargetModel(ctx);
    return true;
  };

  const scanNewDurableEntries = (ctx) => {
    if (promoted) return;
    try {
      const entries = ctx.sessionManager.getEntries();
      const start = entries.length >= inspectedEntryCount ? inspectedEntryCount : 0;
      const uninspectedEntries = start === 0 ? entries : entries.slice(start);
      const hasSignal = hasPromotionSignal(uninspectedEntries);
      inspectedEntryCount = entries.length;
      if (hasSignal) promoted = true;
    } catch {
      promoted = true;
      warnOnce(ctx, "pi-ds-minimal-mode: durable state scan failed; full catalog exposed");
    }
  };

  pi.on("session_start", (_event, ctx) => {
    resetRuntimeState();
    if (isTargetModelId(ctx.model?.id)) activateForTargetModel(ctx);
  });

  pi.on("model_select", (event, ctx) => {
    if (isTargetModelId(event.model.id)) {
      if (!ready) activateForTargetModel(ctx);
      return;
    }
    resetRuntimeState();
  });

  // System prompt is replaced for every target-model agent run. It is the
  // byte-stable Minimal persona and never changes across the session.
  pi.on("before_agent_start", (_event, ctx) => {
    if (!syncTargetModel(ctx)) return undefined;
    scanNewDurableEntries(ctx);
    agentRunActive = true;
    return { systemPrompt: MINIMAL_SYSTEM_PROMPT };
  });

  // Only the first target request is filtered to bash/read. Once promoted, the
  // provider payload is passed through untouched so Pi's full catalog is sent.
  pi.on("before_provider_request", (event, ctx) => {
    if (!ready || !agentRunActive || promoted || !isTargetModelId(ctx.model?.id)) {
      return undefined;
    }

    const payload = event.payload;
    if (
      payload === null ||
      typeof payload !== "object" ||
      !Array.isArray(payload.tools)
    ) {
      warnOnce(
        ctx,
        "pi-ds-minimal-mode: provider tools array unavailable; payload unchanged",
      );
      return undefined;
    }

    try {
      const bootstrap = filterBootstrapToolDefinitions(
        payload.tools,
        SHELL_TOOLS,
        COMMON_TOOLS,
      );
      if (!bootstrap.ok) {
        promoted = true;
        warnOnce(
          ctx,
          `pi-ds-minimal-mode: ${bootstrap.reason}; bootstrap disabled, full catalog exposed`,
        );
        return undefined;
      }
      return { ...payload, tools: bootstrap.tools };
    } catch {
      promoted = true;
      warnOnce(
        ctx,
        "pi-ds-minimal-mode: provider tool filtering failed; bootstrap disabled, full catalog exposed",
      );
      return undefined;
    }
  });

  // Block hallucinated calls to tools that were hidden during bootstrap. A
  // blocked call still counts as activity that promotes the session.
  pi.on("tool_call", (event, ctx) => {
    if (!ready || !agentRunActive || promoted || !isTargetModelId(ctx.model?.id)) {
      return undefined;
    }

    if (!BOOTSTRAP_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason: `pi-ds-minimal-mode: ${event.toolName} is unavailable during bootstrap`,
      };
    }
    return undefined;
  });

  // Pi persists message_end after extension handlers return, so turn_end is the
  // first post-persistence hook for text-only assistant replies. Promoting here
  // keeps resume/fork decisions consistent with the durable entry stream.
  pi.on("turn_end", (event, ctx) => {
    if (
      !ready ||
      !agentRunActive ||
      event.message?.role !== "assistant" ||
      !isTargetModelId(ctx.model?.id)
    ) {
      return;
    }
    promoted = true;
  });

  pi.on("agent_settled", () => {
    agentRunActive = false;
  });

  pi.on("session_shutdown", () => {
    resetRuntimeState();
  });
}
