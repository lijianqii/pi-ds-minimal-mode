/** Keep byte-identical to the DeepSeek Harness Minimal persona. */
export const MINIMAL_SYSTEM_PROMPT = "You are a helpful software engineer assistant.";

const TARGET_MODEL_FRAGMENTS = ["deepseek-v4-flash", "deepseek-v4-pro"];

export function isTargetModelId(modelId) {
  return (
    typeof modelId === "string" &&
    modelId.length > 0 &&
    TARGET_MODEL_FRAGMENTS.some((fragment) =>
      modelId.toLowerCase().includes(fragment),
    )
  );
}

function assistantSignal(entry) {
  if (entry?.type !== "message" || entry.message?.role !== "assistant") {
    return { assistantMessage: false, toolCall: false };
  }

  return {
    assistantMessage: true,
    toolCall:
      Array.isArray(entry.message.content) &&
      entry.message.content.some((block) => block?.type === "toolCall"),
  };
}

/** Derive the append-only phase from Pi's durable session entries. */
export function hasPromotionSignal(entries) {
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) => {
    const signal = assistantSignal(entry);
    return signal.toolCall || signal.assistantMessage;
  });
}

/**
 * Narrow a catalog without introducing tools that were not already present.
 * Invalid catalogs fail open by returning the original input.
 */
export function selectBootstrapTools(activeTools, shellTools, commonTools) {
  const available = new Set(activeTools);
  const selectedShells = shellTools.filter((toolName) => available.has(toolName));

  if (selectedShells.length !== 1) {
    return {
      ok: false,
      tools: [...activeTools],
      reason: `expected exactly one bootstrap shell; found ${JSON.stringify(selectedShells)}`,
    };
  }

  const missingCommon = commonTools.filter((toolName) => !available.has(toolName));
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
    tools: activeTools.filter((toolName) => bootstrap.has(toolName)),
  };
}

function toolDefinitionName(tool) {
  if (typeof tool?.name === "string") return tool.name;
  if (typeof tool?.function?.name === "string") return tool.function.name;
  return undefined;
}

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
