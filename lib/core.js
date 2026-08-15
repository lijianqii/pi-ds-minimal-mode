/**
 * Core primitives for the pi-ds-minimal-mode extension.
 *
 * The byte-stable Minimal alignment prompt is kept here so that the first
 * request to a target DeepSeek V4 model matches the DeepSeek Harness Minimal
 * persona exactly. After the first durable assistant turn, the extension stops
 * filtering tools but keeps the Minimal prompt for every target-model request.
 */

/** Byte-identical to the DeepSeek Harness Minimal persona. */
export const MINIMAL_SYSTEM_PROMPT = "You are a helpful software engineer assistant.";

/**
 * Target model id fragments. A model triggers minimal-mode only when its id
 * (case-insensitive) contains one of these. Only the id is inspected; provider
 * and display name are ignored so that aliases such as
 * `vendor/DeepSeek-V4-Flash-0813` still match.
 */
const TARGET_MODEL_FRAGMENTS = ["deepseek-v4-flash", "deepseek-v4-pro"];

/**
 * @param {string | undefined | null} modelId
 * @returns {boolean}
 */
export function isTargetModelId(modelId) {
  if (typeof modelId !== "string" || modelId.length === 0) return false;
  const lower = modelId.toLowerCase();
  return TARGET_MODEL_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

/**
 * Derive the append-only phase from Pi's durable session entries.
 *
 * Any durable assistant message (text or tool call) promotes the session out
 * of bootstrap. This keeps the promotion decision reproducible across resume,
 * reload, and fork without relying on volatile in-memory state.
 *
 * @param {Array<{type?: string, message?: {role?: string, content?: any[]}}>} entries
 * @returns {boolean}
 */
export function hasPromotionSignal(entries) {
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) => {
    if (entry?.type !== "message") return false;
    if (entry.message?.role !== "assistant") return false;
    return true;
  });
}

/**
 * Narrow an active-tool list to the bootstrap set (one shell + common tools)
 * without introducing tools that were not already present.
 *
 * @param {string[]} activeTools
 * @param {string[]} shellTools
 * @param {string[]} commonTools
 * @returns {{ok: true, tools: string[]} | {ok: false, tools: string[], reason: string}}
 */
export function selectBootstrapTools(activeTools, shellTools, commonTools) {
  const available = new Set(activeTools);
  const selectedShells = shellTools.filter((name) => available.has(name));

  if (selectedShells.length !== 1) {
    return {
      ok: false,
      tools: [...activeTools],
      reason: `expected exactly one bootstrap shell; found ${JSON.stringify(selectedShells)}`,
    };
  }

  const missingCommon = commonTools.filter((name) => !available.has(name));
  if (missingCommon.length > 0) {
    return {
      ok: false,
      tools: [...activeTools],
      reason: `missing common tools: ${JSON.stringify(missingCommon)}`,
    };
  }

  const bootstrap = new Set([...selectedShells, ...commonTools]);
  return {
    ok: true,
    tools: activeTools.filter((name) => bootstrap.has(name)),
  };
}

/**
 * Extract the callable name from either a direct-name or an OpenAI
 * `function.name` tool definition.
 *
 * @param {{name?: string, function?: {name?: string}} | undefined} tool
 * @returns {string | undefined}
 */
function toolDefinitionName(tool) {
  if (typeof tool?.name === "string") return tool.name;
  if (typeof tool?.function?.name === "string") return tool.function.name;
  return undefined;
}

/**
 * Filter a provider tool-definition array down to the bootstrap set, preserving
 * the original ordering. Invalid catalogs fail open by returning the input.
 *
 * @param {any[]} tools
 * @param {string[]} shellTools
 * @param {string[]} commonTools
 * @returns {{ok: true, tools: any[]} | {ok: false, tools: any[], reason: string}}
 */
export function filterBootstrapToolDefinitions(tools, shellTools, commonTools) {
  const names = tools.map(toolDefinitionName).filter((name) => name !== undefined);
  const selection = selectBootstrapTools(names, shellTools, commonTools);
  if (!selection.ok) return { ...selection, tools: [...tools] };

  const bootstrap = new Set(selection.tools);
  return {
    ok: true,
    tools: tools.filter((tool) => bootstrap.has(toolDefinitionName(tool))),
  };
}
