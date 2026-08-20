/**
 * ds-minimal-mode — a Pi coding agent extension.
 *
 * Mirrors the DeepSeek Harness "极简模式" (minimal preset), but ONLY takes
 * effect when the active model is one of TARGET_MODEL_IDS
 * (deepseek-v4-flash / deepseek-v4-pro). For any other model the extension
 * is fully transparent: default system prompt, default tool descriptions,
 * no first-request restriction.
 *
 * When the active model IS a target model:
 *  1. On the FIRST target-model request only, the system prompt is fixed to:
 *       "You are a helpful software engineer assistant."
 *     (the complete persona text from the DeepSeek minimal preset).
 *     Subsequent requests revert to Pi's default system prompt.
 *
 *  2. The built-in `read` and `bash` tools are overridden so their
 *     model-facing descriptions align with the DeepSeek minimal preset:
 *       - bash  → the preset's `persistent-bash` description, verbatim
 *       - read  → aligned to the preset's `str_replace_editor` `view`
 *                 semantics (the minimal preset has no standalone read
 *                 tool; it reads files via `view`). Execution is unchanged.
 *
 *  3. On the very first target-model request of a session, only `bash` is
 *     exposed (see FIRST_REQUEST_TOOLS). Once that request completes
 *     successfully (first turn_end with a non-error stopReason on a target
 *     model), all available tools are enabled for subsequent requests. If the
 *     first request FAILS (network timeout, model unavailable, user abort —
 *     stopReason "error"/"aborted"), the minimal first-request state is kept
 *     so a retry is still restricted to bash with the fixed persona.
 *
 * Switching to a non-target model reverts the tool descriptions to Pi's
 * built-in defaults and lifts any restriction immediately.
 *
 * The first-request restriction is re-applied in multiple hooks
 * (session_start → before_agent_start → turn_start) because setting it
 * once in session_start can be overwritten by later resource discovery
 * / tool re-binding.
 *
 * Install (pick one):
 *   - Global:      copy to ~/.pi/agent/extensions/ds-minimal-mode.ts
 *   - Project:     copy to .pi/extensions/ds-minimal-mode.ts
 *   - Quick test:  pi -e ./ds-minimal-mode.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool, createReadTool } from "@earendil-works/pi-coding-agent";

/** Models for which the DeepSeek-minimal-mode behavior is active. */
const TARGET_MODEL_IDS = ["deepseek-v4-flash", "deepseek-v4-pro"];

/** The complete persona text from the DeepSeek minimal preset. */
const FIXED_SYSTEM_PROMPT = "You are a helpful software engineer assistant.";

/**
 * DeepSeek minimal preset — `persistent-bash` description, verbatim.
 * Source: apps/cli/config/agent-presets/minimal/agent.cordis.yml
 */
const DEEPSEEK_BASH_DESCRIPTION = `Run commands in a bash shell
* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.
* You don't have access to the internet via this tool.
* You do have access to a mirror of common linux and python packages via apt and pip.
* State is persistent across command calls and discussions with the user.
* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.
* Please avoid commands that may produce a very large amount of output.
* Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.`;

/**
 * DeepSeek's minimal preset has no standalone `read` tool — it reads files
 * via `str_replace_editor`'s `view` command. This description aligns Pi's
 * `read` to that view semantics (cat -n, directory listing, line ranges,
 * truncation) while keeping Pi's `offset`/`limit` parameters.
 */
const DEEPSEEK_READ_DESCRIPTION = `View the contents of a file or directory.
* If \`path\` is a file, displays the result of applying \`cat -n\` (with line numbers). If \`path\` is a directory, lists non-hidden files and directories up to 2 levels deep.
* State is persistent across command calls and discussions with the user.
* To inspect a particular line range, use \`offset\` (1-indexed start line) and \`limit\` (number of lines), e.g. offset=10 and limit=16 shows lines 10-25.
* If the output is long, it will be truncated and marked with \`<response clipped>\`.`;

/** Tools exposed to the model on the first target-model request only. */
const FIRST_REQUEST_TOOLS = ["bash"];

/** True when the given model is one of TARGET_MODEL_IDS (id match, case-insensitive). */
const isTargetModel = (model: { id?: string } | undefined): boolean => {
  const id = (model?.id ?? "").toLowerCase();
  // `includes` tolerates version suffixes (e.g. deepseek-v4-flash-2026xx).
  return TARGET_MODEL_IDS.some((t) => id === t || id.includes(t));
};

/**
 * stopReason values that mean a turn completed for real (vs failed/aborted).
 * Per the provider StreamFn contract, network/model/runtime failures are
 * encoded as a final AssistantMessage with stopReason "error" or "aborted"
 * (plus an optional user abort). Those must NOT lift the first-request
 * restriction — the user will retry, and that retry must still be minimal.
 */
const SUCCESS_STOP_REASONS = new Set(["stop", "length", "toolUse", "deferred"]);

/**
 * True when the turn actually completed. `turn_end.message` is an AgentMessage;
 * for a completed assistant turn it carries `role: "assistant"` + `stopReason`.
 * Any other shape (or stopReason "error"/"aborted") is treated as not-done.
 */
const turnSucceeded = (message: unknown): boolean => {
  const m = message as { role?: string; stopReason?: string } | undefined;
  return (
    !!m &&
    m.role === "assistant" &&
    typeof m.stopReason === "string" &&
    SUCCESS_STOP_REASONS.has(m.stopReason)
  );
};

export default function dsMinimalMode(pi: ExtensionAPI) {
  // True once the first TARGET-MODEL request of the session has completed.
  // Reset on every session_start. Non-target requests do not flip this.
  let firstRequestDone = false;

  // Tracks whether read/bash currently carry the DeepSeek descriptions, so we
  // only (re)register them when the target-ness actually changes.
  let descriptionsAreDeepseek = false;

  const cwd = process.cwd();

  /**
   * Apply DeepSeek-style descriptions when on a target model, or revert to
   * Pi's built-in descriptions otherwise. Execution is always delegated to
   * the built-in implementations (createBashTool / createReadTool).
   */
  const applyToolDescriptions = (target: boolean) => {
    if (target === descriptionsAreDeepseek) return;
    descriptionsAreDeepseek = target;

    if (target) {
      pi.registerTool({ ...createBashTool(cwd), description: DEEPSEEK_BASH_DESCRIPTION });
      pi.registerTool({ ...createReadTool(cwd), description: DEEPSEEK_READ_DESCRIPTION });
    } else {
      // Re-register the built-in tools unmodified → restores default descriptions.
      pi.registerTool({ ...createBashTool(cwd) });
      pi.registerTool({ ...createReadTool(cwd) });
    }
  };

  /** Force the active tool set down to the first-request allowlist. */
  const restrictTools = () => {
    const available = new Set(pi.getAllTools().map((t) => t.name));
    const restricted = FIRST_REQUEST_TOOLS.filter((name) => available.has(name));
    pi.setActiveTools(restricted);
    return restricted;
  };

  /** Enable every registered tool. */
  const enableAllTools = () => {
    const allTools = pi.getAllTools().map((t) => t.name);
    if (allTools.length > 0) {
      pi.setActiveTools([...new Set(allTools)]);
    }
  };

  // ------------------------------------------------------------------
  // session_start: reset state, sync descriptions to the startup model,
  // and restrict to FIRST_REQUEST_TOOLS (bash) if it's a target model.
  // ------------------------------------------------------------------
  pi.on("session_start", (_event, ctx) => {
    firstRequestDone = false;
    const target = isTargetModel(ctx.model);
    applyToolDescriptions(target);
    if (target) {
      const restricted = restrictTools();
      if (ctx.hasUI) {
        ctx.ui.notify(
          `First request restricted to: ${restricted.join(", ") || "(no matching tools)"}`,
          "info",
        );
      }
    }
  });

  // ------------------------------------------------------------------
  // model_select: re-sync descriptions + active tools for the new model.
  //   target & first request pending  → restrict to read + bash
  //   otherwise                       → all tools available
  // ------------------------------------------------------------------
  pi.on("model_select", (event, ctx) => {
    const target = isTargetModel(event.model);
    applyToolDescriptions(target);
    if (target && !firstRequestDone) {
      restrictTools();
    } else {
      enableAllTools();
    }
    if (ctx.hasUI) {
      ctx.ui.notify(
        target ? "ds-minimal-mode active." : "ds-minimal-mode inactive (non-target model).",
        "info",
      );
    }
  });

  // ------------------------------------------------------------------
  // before_agent_start: re-assert the restriction (in case resource
  // discovery / tool re-binding reset it) and fix the system prompt —
  // but ONLY on the FIRST target-model request. After that, the system
  // prompt reverts to Pi's default.
  // ------------------------------------------------------------------
  pi.on("before_agent_start", async (_event, ctx) => {
    const firstTargetRequest = isTargetModel(ctx.model) && !firstRequestDone;
    if (firstTargetRequest) restrictTools();
    return firstTargetRequest ? { systemPrompt: FIXED_SYSTEM_PROMPT } : undefined;
  });

  // ------------------------------------------------------------------
  // turn_start: last chance to guarantee the first target-model request
  // only exposes read + bash.
  // ------------------------------------------------------------------
  pi.on("turn_start", (_event, ctx) => {
    if (isTargetModel(ctx.model) && !firstRequestDone) restrictTools();
  });

  // ------------------------------------------------------------------
  // turn_end: the first SUCCESSFUL turn_end ON A TARGET MODEL marks the end
  // of the first target-model request → open up all tools. Non-target turns
  // do not flip firstRequestDone, so the restriction can still trigger when
  // the user later switches to a target model. A failed/aborted first request
  // (stopReason "error"/"aborted") leaves firstRequestDone = false so a retry
  // stays minimal (bash-only + fixed persona) instead of silently reverting
  // to the unmodified Pi environment.
  // ------------------------------------------------------------------
  pi.on("turn_end", (event, ctx) => {
    if (firstRequestDone) return;
    if (!isTargetModel(ctx.model)) return;

    if (!turnSucceeded(event.message)) {
      // First target-model request failed — keep the first-request state
      // intact for the retry.
      if (ctx.hasUI) {
        ctx.ui.notify(
          "First request failed — minimal mode kept for retry (bash only).",
          "warning",
        );
      }
      return;
    }

    firstRequestDone = true;
    enableAllTools();

    if (ctx.hasUI) {
      ctx.ui.notify("First request complete — all tools enabled.", "info");
    }
  });
}
