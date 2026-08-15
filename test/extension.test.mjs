import assert from "node:assert/strict";
import test from "node:test";

const extensionModule = await import("../extensions/ds-minimal-mode.js").catch(() => ({}));

function createPi() {
  const handlers = new Map();
  const activeToolSnapshots = [];
  let currentTools = ["read", "bash", "edit", "write"];

  return {
    api: {
      on(event, handler) {
        const eventHandlers = handlers.get(event) ?? [];
        eventHandlers.push(handler);
        handlers.set(event, eventHandlers);
      },
      registerFlag(name, options) {
        // No flags are registered; kept for API parity.
      },
      getFlag(name) {
        return undefined;
      },
      getActiveTools() {
        return [...currentTools];
      },
      setActiveTools(toolNames) {
        currentTools = [...toolNames];
        activeToolSnapshots.push([...toolNames]);
      },
    },
    handlers,
    activeToolSnapshots,
    get currentTools() {
      return [...currentTools];
    },
  };
}

function createContext(entries = [], notifications = [], options = {}) {
  const failGetEntries = options.failGetEntries ?? false;
  const modelId = Object.hasOwn(options, "modelId")
    ? options.modelId
    : "deepseek-v4-pro-0813";
  return {
    hasUI: true,
    model: modelId === undefined ? undefined : { id: modelId },
    sessionManager: {
      getEntries() {
        const shouldFail =
          typeof failGetEntries === "function" ? failGetEntries() : failGetEntries;
        if (shouldFail) throw new Error("getEntries failed");
        return entries;
      },
    },
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  };
}

async function emit(harness, event, payload, ctx) {
  let result;
  for (const handler of harness.handlers.get(event) ?? []) {
    const next = await handler(payload, ctx);
    if (next !== undefined) result = next;
  }
  return result;
}

function openAiPayload(toolNames = ["read", "bash", "edit", "write"]) {
  return {
    model: "deepseek-v4-pro-0813",
    tools: toolNames.map((name) => ({ type: "function", function: { name } })),
  };
}

function payloadToolNames(payload) {
  return payload.tools.map((tool) => tool.name ?? tool.function?.name);
}

async function start(harness, ctx, reason = "startup") {
  await emit(harness, "session_start", { type: "session_start", reason }, ctx);
}

async function beginAgent(harness, ctx) {
  return emit(
    harness,
    "before_agent_start",
    { type: "before_agent_start", systemPrompt: "Pi default prompt" },
    ctx,
  );
}

async function filterPayload(harness, ctx, payload = openAiPayload()) {
  return emit(
    harness,
    "before_provider_request",
    { type: "before_provider_request", payload },
    ctx,
  );
}

test("registers the promote-on flag under this project's own namespace", () => {
  assert.equal(typeof extensionModule.default, "function");
  const harness = createPi();
  const flags = new Map();
  const api = {
    ...harness.api,
    registerFlag(name, options) {
      flags.set(name, options);
    },
  };
  extensionModule.default(api);
  // Must NOT reuse hank9999's ds-anchored-promote-on name.
  assert.equal(flags.has("ds-anchored-promote-on"), false);
  assert.deepEqual(flags.get("ds-minimal-mode-promote-on"), {
    description: "Promotion trigger: either, tool-call, or assistant-message",
    type: "string",
    default: "either",
  });
});

test("the first target request gets the Minimal prompt and only exposes bash/read", async () => {
  const harness = createPi();
  const ctx = createContext();
  extensionModule.default(harness.api);

  await start(harness, ctx);
  const promptResult = await beginAgent(harness, ctx);
  const payloadResult = await filterPayload(harness, ctx);

  assert.equal(promptResult.systemPrompt, "You are a helpful software engineer assistant.");
  assert.deepEqual(payloadToolNames(payloadResult), ["read", "bash"]);
  // Global active tools are never mutated.
  assert.deepEqual(harness.activeToolSnapshots, []);
  assert.deepEqual(harness.currentTools, ["read", "bash", "edit", "write"]);
});

test("flash model behaves identically to pro on the first request", async () => {
  const harness = createPi();
  const ctx = createContext([], [], { modelId: "deepseek-v4-flash-0813" });
  extensionModule.default(harness.api);

  await start(harness, ctx);
  const promptResult = await beginAgent(harness, ctx);
  const payloadResult = await filterPayload(harness, ctx);

  assert.equal(promptResult.systemPrompt, "You are a helpful software engineer assistant.");
  assert.deepEqual(payloadToolNames(payloadResult), ["read", "bash"]);
});

test("non-target and missing model ids leave prompt, payload, and tools untouched", async () => {
  for (const modelId of ["deepseek-chat", "deepseek-v3", undefined]) {
    const harness = createPi();
    const ctx = createContext([], [], { modelId });
    extensionModule.default(harness.api);

    await start(harness, ctx);
    assert.equal(await beginAgent(harness, ctx), undefined);
    assert.equal(await filterPayload(harness, ctx), undefined);
    assert.deepEqual(harness.activeToolSnapshots, []);
    assert.deepEqual(harness.currentTools, ["read", "bash", "edit", "write"]);
  }
});

test("a text-only first reply promotes the next request after durable turn_end", async () => {
  const harness = createPi();
  const ctx = createContext();
  const assistant = { role: "assistant", content: [{ type: "text", text: "Done" }] };
  extensionModule.default(harness.api);

  await start(harness, ctx);
  await beginAgent(harness, ctx);
  assert.deepEqual(payloadToolNames(await filterPayload(harness, ctx)), ["read", "bash"]);

  await emit(harness, "message_end", { type: "message_end", message: assistant }, ctx);
  // Before turn_end the durable entry is not yet persisted; filtering continues.
  assert.deepEqual(payloadToolNames(await filterPayload(harness, ctx)), ["read", "bash"]);

  await emit(
    harness,
    "turn_end",
    { type: "turn_end", turnIndex: 0, message: assistant, toolResults: [] },
    ctx,
  );
  await beginAgent(harness, ctx);
  // After promotion the payload passes through untouched.
  assert.equal(await filterPayload(harness, ctx), undefined);
});

test("the system prompt stays as Minimal persona after promotion", async () => {
  const harness = createPi();
  const ctx = createContext();
  const assistant = { role: "assistant", content: [{ type: "text", text: "Done" }] };
  extensionModule.default(harness.api);

  await start(harness, ctx);
  await beginAgent(harness, ctx);
  await emit(
    harness,
    "turn_end",
    { type: "turn_end", turnIndex: 0, message: assistant, toolResults: [] },
    ctx,
  );

  const secondRun = await beginAgent(harness, ctx);
  assert.equal(
    secondRun.systemPrompt,
    "You are a helpful software engineer assistant.",
  );
});

test("a tool call during bootstrap is allowed for bash/read and blocked for others", async () => {
  const harness = createPi();
  const ctx = createContext();
  extensionModule.default(harness.api);

  await start(harness, ctx);
  await beginAgent(harness, ctx);

  const readResult = await emit(
    harness,
    "tool_call",
    { type: "tool_call", toolCallId: "call-1", toolName: "read", input: {} },
    ctx,
  );
  assert.equal(readResult, undefined);

  const writeResult = await emit(
    harness,
    "tool_call",
    { type: "tool_call", toolCallId: "call-2", toolName: "write", input: {} },
    ctx,
  );
  assert.deepEqual(writeResult, {
    block: true,
    reason: "pi-ds-minimal-mode: write is unavailable during bootstrap",
  });
});

test("a hallucinated hidden bootstrap tool is blocked and promotes after turn_end", async () => {
  const harness = createPi();
  const ctx = createContext();
  extensionModule.default(harness.api);

  await start(harness, ctx);
  await beginAgent(harness, ctx);
  const result = await emit(
    harness,
    "tool_call",
    { type: "tool_call", toolCallId: "call-1", toolName: "write", input: {} },
    ctx,
  );

  assert.deepEqual(result, {
    block: true,
    reason: "pi-ds-minimal-mode: write is unavailable during bootstrap",
  });
  await emit(
    harness,
    "turn_end",
    {
      type: "turn_end",
      turnIndex: 0,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "write", arguments: {} }],
      },
      toolResults: [],
    },
    ctx,
  );
  assert.equal(await filterPayload(harness, ctx), undefined);
});

test("resume derives promoted state from durable session entries", async () => {
  const entries = [
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "Earlier" }] },
    },
  ];
  const harness = createPi();
  const ctx = createContext(entries);
  extensionModule.default(harness.api);

  await start(harness, ctx, "resume");
  const promptResult = await beginAgent(harness, ctx);

  assert.equal(promptResult.systemPrompt, "You are a helpful software engineer assistant.");
  assert.equal(await filterPayload(harness, ctx), undefined);
});

test("model switching activates and deactivates request filtering without global tool changes", async () => {
  const harness = createPi();
  const ctx = createContext([], [], { modelId: "deepseek-chat" });
  extensionModule.default(harness.api);

  await start(harness, ctx);
  assert.equal(await beginAgent(harness, ctx), undefined);

  const nonTarget = ctx.model;
  ctx.model = { id: "provider/DeepSeek-V4-Pro-0813" };
  await emit(
    harness,
    "model_select",
    { type: "model_select", model: ctx.model, previousModel: nonTarget, source: "set" },
    ctx,
  );
  assert.equal(
    (await beginAgent(harness, ctx)).systemPrompt,
    "You are a helpful software engineer assistant.",
  );
  assert.deepEqual(payloadToolNames(await filterPayload(harness, ctx)), ["read", "bash"]);

  const target = ctx.model;
  ctx.model = { id: "deepseek-chat" };
  await emit(
    harness,
    "model_select",
    { type: "model_select", model: ctx.model, previousModel: target, source: "set" },
    ctx,
  );
  assert.equal(await beginAgent(harness, ctx), undefined);
  assert.equal(await filterPayload(harness, ctx), undefined);
  assert.deepEqual(harness.activeToolSnapshots, []);
});

test("switching into a flash target model starts bootstrap when session is empty", async () => {
  const harness = createPi();
  const ctx = createContext([], [], { modelId: "other-model" });
  extensionModule.default(harness.api);

  await start(harness, ctx);
  ctx.model = { id: "deepseek-v4-flash-0813" };
  await emit(
    harness,
    "model_select",
    { type: "model_select", model: ctx.model, previousModel: { id: "other-model" }, source: "set" },
    ctx,
  );
  assert.equal(
    (await beginAgent(harness, ctx)).systemPrompt,
    "You are a helpful software engineer assistant.",
  );
  assert.deepEqual(payloadToolNames(await filterPayload(harness, ctx)), ["read", "bash"]);
});

test("switching into a target model with durable history starts promoted", async () => {
  const entries = [
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "Earlier" }] },
    },
  ];
  const harness = createPi();
  const ctx = createContext(entries, [], { modelId: "other-model" });
  extensionModule.default(harness.api);

  await start(harness, ctx);
  ctx.model = { id: "deepseek-v4-pro-0813" };
  await emit(
    harness,
    "model_select",
    { type: "model_select", model: ctx.model, previousModel: { id: "other-model" }, source: "set" },
    ctx,
  );
  await beginAgent(harness, ctx);
  assert.equal(await filterPayload(harness, ctx), undefined);
});

test("missing bootstrap definitions fail open once without mutating global tools", async () => {
  const notifications = [];
  const harness = createPi();
  const ctx = createContext([], notifications);
  extensionModule.default(harness.api);

  await start(harness, ctx);
  await beginAgent(harness, ctx);
  assert.equal(await filterPayload(harness, ctx, openAiPayload(["bash", "edit"])), undefined);
  // Once failed open, promotion is sticky.
  assert.equal(await filterPayload(harness, ctx), undefined);

  // Activation fires an info-level notify; filter to warnings only.
  const warnings = notifications.filter((n) => n.level === "warning");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /bootstrap disabled.*full catalog/i);
  assert.deepEqual(harness.activeToolSnapshots, []);
});

test("a provider payload without tools is left unchanged without consuming bootstrap", async () => {
  const notifications = [];
  const harness = createPi();
  const ctx = createContext([], notifications);
  extensionModule.default(harness.api);

  await start(harness, ctx);
  await beginAgent(harness, ctx);
  assert.equal(
    await filterPayload(harness, ctx, { model: "deepseek-v4-pro-0813" }),
    undefined,
  );
  assert.deepEqual(payloadToolNames(await filterPayload(harness, ctx)), ["read", "bash"]);
  // Activation fires an info-level notify; filter to warnings only.
  const warnings = notifications.filter((n) => n.level === "warning");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /tools array unavailable.*payload unchanged/i);
});

test("session inspection failure keeps the Minimal prompt but fails open on tools", async () => {
  const notifications = [];
  const harness = createPi();
  const ctx = createContext([], notifications, { failGetEntries: true });
  extensionModule.default(harness.api);

  await start(harness, ctx, "resume");
  assert.equal(
    (await beginAgent(harness, ctx)).systemPrompt,
    "You are a helpful software engineer assistant.",
  );
  assert.equal(await filterPayload(harness, ctx), undefined);
  assert.match(notifications[0].message, /session state inspection failed.*full catalog/i);
});

test("agent_settled stops filtering unrelated provider work", async () => {
  const harness = createPi();
  const ctx = createContext();
  extensionModule.default(harness.api);

  await start(harness, ctx);
  await beginAgent(harness, ctx);
  assert.deepEqual(payloadToolNames(await filterPayload(harness, ctx)), ["read", "bash"]);

  await emit(harness, "agent_settled", { type: "agent_settled" }, ctx);
  assert.equal(await filterPayload(harness, ctx), undefined);
});

test("session_shutdown resets runtime state so a fresh target session re-bootstraps", async () => {
  const harness = createPi();
  const ctx = createContext();
  extensionModule.default(harness.api);

  await start(harness, ctx);
  await beginAgent(harness, ctx);
  const assistant = { role: "assistant", content: [{ type: "text", text: "Done" }] };
  await emit(
    harness,
    "turn_end",
    { type: "turn_end", turnIndex: 0, message: assistant, toolResults: [] },
    ctx,
  );
  assert.equal(await filterPayload(harness, ctx), undefined);

  await emit(harness, "session_shutdown", { type: "session_shutdown" }, ctx);
  await start(harness, ctx, "new");
  await beginAgent(harness, ctx);
  assert.deepEqual(payloadToolNames(await filterPayload(harness, ctx)), ["read", "bash"]);
});

test("multiple consecutive target turns keep the Minimal prompt and full catalog after promotion", async () => {
  const harness = createPi();
  const ctx = createContext();
  extensionModule.default(harness.api);

  await start(harness, ctx);
  await beginAgent(harness, ctx);
  assert.deepEqual(payloadToolNames(await filterPayload(harness, ctx)), ["read", "bash"]);

  const assistant = { role: "assistant", content: [{ type: "text", text: "Done" }] };
  await emit(
    harness,
    "turn_end",
    { type: "turn_end", turnIndex: 0, message: assistant, toolResults: [] },
    ctx,
  );

  for (let i = 1; i <= 3; i++) {
    const run = await beginAgent(harness, ctx);
    assert.equal(run.systemPrompt, "You are a helpful software engineer assistant.");
    assert.equal(await filterPayload(harness, ctx), undefined);
  }
});
