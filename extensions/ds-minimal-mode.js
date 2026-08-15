/**
 * Two-phase DeepSeek Minimal-mode extension for Pi.
 *
 * Only model ids containing `deepseek-v4-flash` or `deepseek-v4-pro` are
 * affected. Their request #1 receives the Minimal prompt plus bash/read. After
 * the configured durable signal, later requests recover the full provider tool
 * catalog while the Minimal prompt is retained.
 *
 * Derived from hank9999/pi-ds-anchored with two changes:
 *  - Target models extended to deepseek-v4-flash and deepseek-v4-pro.
 *  - The promote-on flag is renamed to this project's own namespace
 *    (ds-minimal-mode-promote-on) to avoid any clash with the upstream
 *    extension's ds-anchored-promote-on flag if both are installed.
 *
 * Everything else mirrors hank9999's verified-working structure: sync
 * handlers, no optional chaining on event.message, no module-top-level
 * process.env reads, no console.log diagnostics.
 */

import {
  MINIMAL_SYSTEM_PROMPT,
  filterBootstrapToolDefinitions,
  hasPromotionSignal,
  isTargetModelId,
  parsePromoteOn,
} from "../lib/core.js";

/**
 * @typedef {import("@earendil-works/pi-coding-agent").ExtensionAPI} ExtensionAPI
 */

const PROMOTE_ON_FLAG = "ds-minimal-mode-promote-on";

const SHELL_TOOLS = ["bash"];
const COMMON_TOOLS = ["read"];
const BOOTSTRAP_TOOLS = new Set([...SHELL_TOOLS, ...COMMON_TOOLS]);

/** @param {ExtensionAPI} pi */
export default function dsMinimalMode(pi) {
  let ready = false;
  let promoted = false;
  let promoteOn = "either";
  let warned = false;
  let inspectedEntryCount = 0;
  let agentRunActive = false;
  let promotionPending = false;

  pi.registerFlag(PROMOTE_ON_FLAG, {
    description: "Promotion trigger: either, tool-call, or assistant-message",
    type: "string",
    default: "either",
  });

  const warnOnce = (ctx, message) => {
    if (warned) return;
    warned = true;
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
    else console.warn(message);
  };

  const resetRuntimeState = () => {
    ready = false;
    promoted = false;
    promoteOn = "either";
    warned = false;
    inspectedEntryCount = 0;
    agentRunActive = false;
    promotionPending = false;
  };

  const activateForTargetModel = (ctx) => {
    resetRuntimeState();
    promoteOn = parsePromoteOn(pi.getFlag(PROMOTE_ON_FLAG));
    try {
      const entries = ctx.sessionManager.getEntries();
      promoted = hasPromotionSignal(entries, promoteOn);
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
      const hasSignal = hasPromotionSignal(uninspectedEntries, promoteOn);
      inspectedEntryCount = entries.length;
      if (hasSignal) {
        promoted = true;
        promotionPending = false;
      }
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

  pi.on("before_agent_start", (_event, ctx) => {
    if (!syncTargetModel(ctx)) return undefined;
    scanNewDurableEntries(ctx);
    agentRunActive = true;
    return { systemPrompt: MINIMAL_SYSTEM_PROMPT };
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (
      !ready ||
      !agentRunActive ||
      promoted ||
      !isTargetModelId(ctx.model?.id)
    ) {
      return undefined;
    }

    const payload = event.payload;
    if (payload === null || typeof payload !== "object" || !Array.isArray(payload.tools)) {
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

  pi.on("tool_call", (event, ctx) => {
    if (
      !ready ||
      !agentRunActive ||
      promoted ||
      !isTargetModelId(ctx.model?.id)
    ) {
      return undefined;
    }

    const hiddenDuringBootstrap = !BOOTSTRAP_TOOLS.has(event.toolName);
    if (promoteOn !== "assistant-message") promotionPending = true;

    if (hiddenDuringBootstrap) {
      return {
        block: true,
        reason: `pi-ds-minimal-mode: ${event.toolName} is unavailable during bootstrap`,
      };
    }
    return undefined;
  });

  // Pi persists message_end after extension handlers return. turn_end therefore
  // provides the first post-persistence hook for text-only assistant replies.
  pi.on("turn_end", (event, ctx) => {
    if (
      !ready ||
      !agentRunActive ||
      event.message.role !== "assistant" ||
      !isTargetModelId(ctx.model?.id)
    ) {
      return;
    }
    if (promotionPending || promoteOn !== "tool-call") {
      promoted = true;
      promotionPending = false;
    }
  });

  pi.on("agent_settled", () => {
    agentRunActive = false;
    promotionPending = false;
  });

  pi.on("session_shutdown", () => {
    resetRuntimeState();
  });
}
