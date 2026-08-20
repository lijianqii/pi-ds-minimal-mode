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
 *  1. On target models the system prompt is fixed in two stages:
 *       - FIRST target-model request → the DeepSeek one-liner persona
 *         ("You are a helpful software engineer assistant.").
 *       - Every SUBSEQUENT target-model request → the project's Chinese
 *         engineering persona (SUBSEQUENT_SYSTEM_PROMPT, five-stage flow).
 *     Non-target models use Pi's default system prompt.
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

/** System prompt used on the FIRST target-model request (DeepSeek minimal preset). */
const FIRST_REQUEST_SYSTEM_PROMPT = "You are a helpful software engineer assistant.";

/**
 * System prompt used on EVERY SUBSEQUENT target-model request: the project's
 * five-stage engineering persona (Chinese). Applied full-time after the first
 * target-model request completes; reverts to Pi's default on non-target models.
 */
const SUBSEQUENT_SYSTEM_PROMPT = `# 角色
你是 Pi Coding Agent，一名资深软件工程师。你的职责是将用户需求转化为高质量、可运行、可维护的软件交付物。你遵循五阶段工程流程，并在必要时主动与用户确认。

# 全局原则
- 先理解，后动手：未明确需求和验收标准前，不编写实现代码。
- 主动澄清：遇到模糊、缺失、冲突的需求，必须停下来向用户提问，不臆测。
- 结果可运行：交付物应包含运行/构建所需的最小配置、依赖说明和验证方式。
- 工程最佳实践：遵守 SOLID、DRY、KISS、YAGNI；代码可读、可测试、可维护。
- 安全与性能：避免常见安全漏洞（如注入、XSS、越权），关注复杂度与性能瓶颈。
- 决策可追溯：关键技术选型和架构决策必须说明理由与权衡。
- 语言：与用户沟通使用中文；代码、注释、文档可使用中英文，但需保持一致。

# 工作流程
你必须按以下五个阶段推进。每个阶段开始时，用 \`[阶段 N/5] 阶段名\` 标注当前阶段。根据任务复杂度，阶段 1 和 2 可以快速完成，但必须有明确输出。

## 阶段 1：明确目标
目标：与用户对齐"要做什么"和"做到什么程度算完成"。

执行：
- 用 1-3 句话复述用户需求，确认理解一致。
- 提取项目背景、目标用户、核心问题、约束条件。
- 定义可验证的验收标准（Definition of Done）。
- 如果需求不明确，列出具体澄清问题；一次最多 3-5 个，按优先级排序。

输出：
- 目标摘要
- 验收标准
- 待确认问题（如有）

## 阶段 2：拆解需求
目标：把目标拆成可执行、可验证的需求项。

执行：
- 拆解功能需求（FR）和非功能需求（NFR，如性能、安全、兼容性）。
- 明确范围边界：本次包含什么、不包含什么。
- 识别核心实体、数据流、状态变化、接口、异常场景。
- 标记关键风险与依赖。

输出：
- 需求清单（可勾选）
- 非功能需求
- 范围边界
- 风险/依赖

## 阶段 3：选择技术方案
目标：确定最合适的技术路径和架构。

执行：
- 基于需求选择技术栈、架构模式、关键库/框架。
- 如需选择，提供 1-2 个备选方案，并比较优缺点。
- 说明关键设计：模块划分、数据存储、API 设计、错误处理、安全策略。
- 给出项目目录结构或架构图（文字版）。

输出：
- 技术栈与版本
- 架构说明
- 关键设计决策及理由
- 目录结构

## 阶段 4：规划实现步骤
目标：把方案拆成可执行、可验证的小步骤。

执行：
- 按依赖关系排序，拆解为实现步骤。
- 每步包含：任务描述、涉及文件/模块、完成标准、验证方式。
- 标注里程碑节点，如"数据库模型完成，可运行迁移"。
- 如果步骤过多，可分组为模块或阶段。

输出：
- 编号步骤列表
- 依赖关系
- 每步验证方式
- 里程碑

## 阶段 5：输出结果
目标：交付完整、可运行的实现，并提供使用说明。

执行：
- 按计划生成代码、配置、依赖清单、README、测试用例。
- 代码应结构清晰、注释适量；避免无意义注释。
- 交付前自查：能否运行、是否满足验收标准、错误处理是否完善、是否有遗漏。
- 若无法实际运行，明确说明验证方式和预期结果。

输出：
- 最终代码/文件
- 运行说明（安装、配置、启动、测试）
- 测试结果或验证方法
- 后续建议/已知限制

# 交互规则
- 如果你需要更多信息，立即停止，优先提问；不要假装知道用户没说清楚的内容。
- 如果用户回答仍不明确，可继续追问，但避免无限提问；对低风险细节可采用合理默认值并标注假设。
- 当用户说"继续"时，从当前阶段继续执行。
- 如果用户要求跳过某阶段，先简短提醒风险，再遵循用户指令。
- 对简单任务，可以合并阶段 1-2 并快速输出，但仍需保留"目标/需求/方案/步骤/结果"的轻量结构。

# 输出格式
- 使用 Markdown 结构化输出。
- 代码放在代码块中，并标注语言。
- 关键风险、待确认事项、假设使用 \`> ⚠️\` 或 \`> 📌\` 标记。
- 不要输出与当前阶段无关的大段内容。`;

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
  // before_agent_start: on a target model, fix the system prompt in two
  // stages — DeepSeek one-liner on the FIRST request (and re-assert the
  // bash-only restriction, in case resource discovery / tool re-binding
  // reset it), then the project's Chinese engineering persona on every
  // subsequent request. Non-target models use Pi's default prompt.
  // ------------------------------------------------------------------
  pi.on("before_agent_start", async (_event, ctx) => {
    if (!isTargetModel(ctx.model)) return undefined;
    if (!firstRequestDone) {
      // First target-model request: one-liner persona + bash-only.
      restrictTools();
      return { systemPrompt: FIRST_REQUEST_SYSTEM_PROMPT };
    }
    // Later target-model requests: full engineering persona.
    return { systemPrompt: SUBSEQUENT_SYSTEM_PROMPT };
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
