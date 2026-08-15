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
 * Diagnostics: set PI_DS_MINIMAL_DEBUG=1 in the environment to emit verbose
 * console logs at every decision point. A one-time UI notification fires when
 * a target model is first activated so you can confirm the extension loaded.
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

const DEBUG = process.env.PI_DS_MINIMAL_DEBUG === "1";

const TAG = "pi-ds-minimal-mode";

/** @param {ExtensionAPI} pi */
export default function dsMinimalMode(pi) {
  if (DEBUG) console.log(`[${TAG}] extension module loaded (debug=on)`);

  let ready = false;
  let promoted = false;
  let warned = false;
  let inspectedEntryCount = 0;
  let agentRunActive = false;
  let activationNotified = false;

  const diag = (message) => {
    if (DEBUG) console.log(`[${TAG}] ${message}`);
  };

  const warnOnce = (ctx, message) => {
    if (warned) return;
    warned = true;
    if (ctx?.hasUI) ctx.ui.notify(message, "warning");
    else console.warn(message);
  };

  const notifyOnce = (ctx, message, level = "info") => {
    if (activationNotified) return;
    activationNotified = true;
    if (ctx?.hasUI) ctx.ui.notify(message, level);
    else console.log(`[${TAG}] ${message}`);
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
      warnOnce(ctx, `${TAG}: session state inspection failed; full catalog exposed`);
    }
    ready = true;
    const modelId = ctx.model?.id ?? "<unknown>";
    notifyOnce(
      ctx,
      `${TAG}: active — target model "${modelId}" detected, bootstrap=${!promoted}`,
    );
    diag(`activated for model="${modelId}" promoted=${promoted}`);
  };

  const syncTargetModel = (ctx) => {
    const modelId = ctx.model?.id;
    if (!isTargetModelId(modelId)) {
      diag(`syncTargetModel: model="${modelId ?? "<none>"}" is NOT a target; skipping`);
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
      if (hasSignal) {
        promoted = true;
        diag("scanNewDurableEntries: promotion signal found, promoted=true");
      }
    } catch {
      promoted = true;
      warnOnce(ctx, `${TAG}: durable state scan failed; full catalog exposed`);
    }
  };

  pi.on("session_start", (_event, ctx) => {
    diag(`session_start: model="${ctx.model?.id ?? "<none>"}"`);
    resetRuntimeState();
    activationNotified = false;
    if (isTargetModelId(ctx.model?.id)) activateForTargetModel(ctx);
  });

  pi.on("model_select", (event, ctx) => {
    diag(`model_select: new model="${event.model?.id ?? "<none>"}"`);
    if (isTargetModelId(event.model?.id)) {
      if (!ready) activateForTargetModel(ctx);
      return;
    }
    resetRuntimeState();
  });

  // System prompt is replaced for every target-model agent run. It is the
  // byte-stable Minimal persona and never changes across the session.
  //
  // IMPORTANT: this handler MUST be synchronous. hank9999/pi-ds-anchored (the
  // verified-working reference) uses a sync handler. If this is async, the
  // function body runs in a microtask, so the returned { systemPrompt } is a
  // Promise by the time Pi's synchronous hook dispatcher consumes it —
  // `Promise.systemPrompt` is undefined and the replacement silently no-ops.
  // The same delay also defers the `agentRunActive = true` side effect, which
  // can make before_provider_request skip tool filtering. Keep this sync.
  pi.on("before_agent_start", (_event, ctx) => {
    if (!syncTargetModel(ctx)) return undefined;
    scanNewDurableEntries(ctx);
    agentRunActive = true;
    diag(
      `before_agent_start: replacing systemPrompt with Minimal persona (${MINIMAL_SYSTEM_PROMPT.length} chars), promoted=${promoted}`,
    );
    return { systemPrompt: MINIMAL_SYSTEM_PROMPT };
  });

  // Only the first target request is filtered to bash/read. Once promoted, the
  // provider payload is passed through untouched so Pi's full catalog is sent.
  pi.on("before_provider_request", (event, ctx) => {
    if (!ready || !agentRunActive || promoted || !isTargetModelId(ctx.model?.id)) {
      diag(
        `before_provider_request: passthrough (ready=${ready} active=${agentRunActive} promoted=${promoted} target=${isTargetModelId(ctx.model?.id)})`,
      );
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
        `${TAG}: provider tools array unavailable; payload unchanged`,
      );
      return undefined;
    }

    const beforeNames = payload.tools.map(
      (t) => t?.name ?? t?.function?.name ?? "?",
    );
    diag(`before_provider_request: filtering tools ${JSON.stringify(beforeNames)} -> [bash, read]`);

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
          `${TAG}: ${bootstrap.reason}; bootstrap disabled, full catalog exposed`,
        );
        return undefined;
      }
      return { ...payload, tools: bootstrap.tools };
    } catch {
      promoted = true;
      warnOnce(
        ctx,
        `${TAG}: provider tool filtering failed; bootstrap disabled, full catalog exposed`,
      );
      return undefined;
    }
  });

  // Block hallucinated calls to tools that were hidden during bootstrap.
  pi.on("tool_call", (event, ctx) => {
    if (!ready || !agentRunActive || promoted || !isTargetModelId(ctx.model?.id)) {
      return undefined;
    }

    if (!BOOTSTRAP_TOOLS.has(event.toolName)) {
      diag(`tool_call: blocking hidden tool "${event.toolName}" during bootstrap`);
      return {
        block: true,
        reason: `${TAG}: ${event.toolName} is unavailable during bootstrap`,
      };
    }
    return undefined;
  });

  // Pi persists message_end after extension handlers return, so turn_end is the
  // first post-persistence hook for text-only assistant replies.
  pi.on("turn_end", (event, ctx) => {
    if (
      !ready ||
      !agentRunActive ||
      event.message?.role !== "assistant" ||
      !isTargetModelId(ctx.model?.id)
    ) {
      return;
    }
    diag("turn_end: assistant message detected, promoting to full catalog");
    promoted = true;
  });

  pi.on("agent_settled", () => {
    agentRunActive = false;
  });

  pi.on("session_shutdown", () => {
    diag("session_shutdown: resetting runtime state");
    resetRuntimeState();
  });
}
