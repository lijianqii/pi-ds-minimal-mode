import assert from "node:assert/strict";
import test from "node:test";

const core = await import("../lib/core.js").catch(() => ({}));

test("exports the byte-stable Minimal alignment prompt", () => {
  assert.equal(
    core.MINIMAL_SYSTEM_PROMPT,
    "You are a helpful software engineer assistant.",
  );
});

test("isTargetModelId matches deepseek-v4-flash ids", () => {
  assert.equal(typeof core.isTargetModelId, "function");
  assert.equal(core.isTargetModelId("deepseek-v4-flash-0813"), true);
  assert.equal(core.isTargetModelId("vendor/DeepSeek-V4-Flash-0813"), true);
  assert.equal(core.isTargetModelId("DEEPSEEK-V4-FLASH"), true);
});

test("isTargetModelId matches deepseek-v4-pro ids", () => {
  assert.equal(core.isTargetModelId("deepseek-v4-pro-0813"), true);
  assert.equal(core.isTargetModelId("vendor/DeepSeek-V4-Pro-0813"), true);
  assert.equal(core.isTargetModelId("DEEPSEEK-V4-PRO"), true);
});

test("isTargetModelId rejects non-target and missing ids", () => {
  assert.equal(core.isTargetModelId("deepseek-chat"), false);
  assert.equal(core.isTargetModelId("deepseek-v4"), false);
  assert.equal(core.isTargetModelId("deepseek-v3"), false);
  assert.equal(core.isTargetModelId(""), false);
  assert.equal(core.isTargetModelId(undefined), false);
  assert.equal(core.isTargetModelId(null), false);
  assert.equal(core.isTargetModelId(123), false);
});

test("isTargetModelId uses substring semantics, so extended model ids still match", () => {
  // "deepseek-v4-flasher" still contains "deepseek-v4-flash" substring.
  // "deepseek-v4-proximity" still contains "deepseek-v4-pro" substring.
  // Both are acceptable per the documented substring matching semantics.
  assert.equal(core.isTargetModelId("deepseek-v4-flasher"), true);
  assert.equal(core.isTargetModelId("deepseek-v4-proximity"), true);
  // But a model that merely shares the "flash" or "pro" token without the full
  // fragment must not match.
  assert.equal(core.isTargetModelId("some-flash-model"), false);
  assert.equal(core.isTargetModelId("some-pro-model"), false);
  assert.equal(core.isTargetModelId("deepseek-v3-flash"), false);
});

test("hasPromotionSignal keeps an empty session in bootstrap", () => {
  assert.equal(typeof core.hasPromotionSignal, "function");
  assert.equal(core.hasPromotionSignal([], "either"), false);
});

test("a text-only assistant message promotes", () => {
  const entries = [
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
    },
  ];
  assert.equal(core.hasPromotionSignal(entries, "either"), true);
});

test("an assistant toolCall promotes", () => {
  const entries = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
      },
    },
  ];
  assert.equal(core.hasPromotionSignal(entries, "either"), true);
});

test("user messages do not promote", () => {
  const entries = [
    {
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "Hi" }] },
    },
  ];
  assert.equal(core.hasPromotionSignal(entries, "either"), false);
});

test("non-message entries do not promote", () => {
  const entries = [{ type: "tool_result", toolCallId: "call-1" }];
  assert.equal(core.hasPromotionSignal(entries, "either"), false);
});

test("selectBootstrapTools preserves catalog order while keeping bash and read", () => {
  assert.equal(typeof core.selectBootstrapTools, "function");
  assert.deepEqual(
    core.selectBootstrapTools(["read", "bash", "edit", "write"], ["bash"], ["read"]),
    { ok: true, tools: ["read", "bash"] },
  );
});

test("filterBootstrapToolDefinitions supports OpenAI function tool payloads", () => {
  assert.equal(typeof core.filterBootstrapToolDefinitions, "function");
  const tools = [
    { type: "function", function: { name: "read" } },
    { type: "function", function: { name: "bash" } },
    { type: "function", function: { name: "edit" } },
  ];
  assert.deepEqual(
    core.filterBootstrapToolDefinitions(tools, ["bash"], ["read"]),
    { ok: true, tools: tools.slice(0, 2) },
  );
});

test("filterBootstrapToolDefinitions supports direct-name tool payloads", () => {
  const tools = [{ name: "bash" }, { name: "write" }, { name: "read" }];
  assert.deepEqual(
    core.filterBootstrapToolDefinitions(tools, ["bash"], ["read"]),
    { ok: true, tools: [tools[0], tools[2]] },
  );
});

test("filterBootstrapToolDefinitions fails open when a required definition is absent", () => {
  const tools = [{ name: "bash" }, { name: "edit" }];
  const result = core.filterBootstrapToolDefinitions(tools, ["bash"], ["read"]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.tools, tools);
  assert.match(result.reason, /missing common tools.*read/i);
});

test("selectBootstrapTools fails open when no configured shell is active", () => {
  const activeTools = ["read", "edit", "write"];
  const result = core.selectBootstrapTools(activeTools, ["bash"], ["read"]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.tools, activeTools);
  assert.match(result.reason, /exactly one bootstrap shell/i);
});

test("selectBootstrapTools fails open when a common tool is missing", () => {
  const activeTools = ["bash", "edit", "write"];
  const result = core.selectBootstrapTools(activeTools, ["bash"], ["read"]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.tools, activeTools);
  assert.match(result.reason, /missing common tools.*read/i);
});
