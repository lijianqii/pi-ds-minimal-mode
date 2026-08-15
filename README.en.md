# pi-ds-minimal-mode

[中文](./README.md)

An experimental Pi extension for alignment-trajectory testing on **DeepSeek V4 Flash** and **DeepSeek V4 Pro**. It inspects the current `model.id` and activates only when the id (case-insensitive) contains `deepseek-v4-flash` or `deepseek-v4-pro`; the system prompt and tool catalog of every other model are left untouched.

The **first request** to a target model uses the DeepSeek Harness Minimal system prompt and exposes only `bash` and `read`. **Subsequent requests** keep Pi's full active tool catalog while the system prompt stays as the Minimal persona throughout the session. This anchors the first request to a minimal trajectory, then seamlessly restores full tooling.

This is a community project. It is not a DeepSeek or Pi official extension, nor does it represent any official endorsement.

The design is derived from https://github.com/hank9999/pi-ds-anchored , extending the target models to both Flash and Pro and simplifying to a single promotion strategy.

## How it works

The extension separates "first-request minimal anchoring" from "subsequent full tooling":

1. The current `model.id` is checked for `deepseek-v4-flash` or `deepseek-v4-pro` (case-insensitive substring). Only the id is inspected; provider and display name are ignored.
2. For matching models, every agent run replaces Pi's system prompt with the byte-stable text:

   ```text
   You are a helpful software engineer assistant.
   ```

   This prompt is constant across the entire session.
3. The first target agent run filters the provider-bound tool definitions in `before_provider_request`, keeping only `bash` and `read`. Pi's global active-tool state is never modified, so request #1 sees only two API tools without polluting non-target models.
4. After the first durable `assistant` message (text reply or tool call, whichever comes first), filtering stops. Request #2 onward sees Pi's original full catalog; a text-only first reply does not strand the session in bootstrap.
5. `session_start` scans durable session entries to restore the phase, so resume, reload, and fork do not depend on volatile in-memory state.
6. Switching to a non-target model via `/model` immediately deactivates prompt replacement and request filtering; switching back re-initializes from durable session state.
7. If `bash` or `read` is absent, the extension warns once and fails open: the full catalog is preserved rather than failing the request.

"Full catalog" means the provider payload Pi normally generates from the currently active tools, not forcibly enabling all registered tools. The extension never calls `setActiveTools()`, so `--tools`, `--exclude-tools`, default-off `grep/find/ls`, and other extensions' dynamic tool strategies are all preserved.

## Differences from pi-ds-anchored

| Aspect | pi-ds-anchored | pi-ds-minimal-mode |
|---|---|---|
| Target models | `deepseek-v4-pro` only | `deepseek-v4-flash` and `deepseek-v4-pro` |
| Promotion strategy | Configurable (`either` / `tool-call` / `assistant-message`) | Fixed: promote after first assistant reply |
| Configuration | `--ds-anchored-promote-on` flag | None (works out of the box) |
| First request | Minimal prompt + bash/read | Minimal prompt + bash/read |
| Subsequent requests | Full catalog, Minimal prompt | Full catalog, Minimal prompt unchanged |

## Install and run

Try it directly from the parent directory:

```sh
pi -e ./pi-ds-minimal-mode/extensions/ds-minimal-mode.js
```

Install as a local Pi package:

```sh
pi install ./pi-ds-minimal-mode
```

Project-level install:

```sh
pi install ./pi-ds-minimal-mode -l
```

Enable/disable with `pi config` or `pi config -l`.

> The extension auto-detects `model.id`. For example, `deepseek-v4-flash-0813`, `deepseek-v4-pro-0813`, and `provider/DeepSeek-V4-Pro-0813` activate; `deepseek-chat`, other models, or a missing id do not.

## Verification

Run the zero-dependency tests:

```sh
cd pi-ds-minimal-mode
npm test
npm run check
```

Real requests should satisfy:

- Non-target model ids do not modify the system prompt or active tools;
- When `model.id` contains `deepseek-v4-flash` or `deepseek-v4-pro`, request #1's API tool catalog is only `bash` and `read`;
- After the first assistant reply, the next request stops filtering and sees Pi's full catalog;
- Subsequent requests keep the full catalog; the system prompt is always the Minimal persona;
- Resuming a session that already produced a reply keeps the full catalog.

To verify API-level payloads, temporarily load a debug extension that records `before_provider_request` and inspect the system prompt and tools in the request; do not log API keys, user content, or other sensitive fields.

## Important limitations

- **Full system-prompt replacement:** Pi defaults, `AGENTS.md`/`CLAUDE.md`, skills summaries, tool guidance, `--system-prompt`, and `--append-system-prompt` will not appear in the final system prompt. This is the behavior required for alignment experiments, not a safe default for a general coding assistant.
- **Model switching on existing sessions:** Auto-detection supports `/model` switching, but if you switch into a target model on a session that already has assistant messages, the durable state is immediately judged promoted and cannot reproduce "first-request anchoring". For precise experiments, start a fresh empty session.
- **Extension ordering:** Pi's `before_agent_start` and `before_provider_request` handlers chain in load order. If a later-loaded extension rewrites the system prompt or tool array, the result is no longer byte-identical to the Minimal prompt / two-tool catalog. For precise experiments, load this extension last and inspect the actual payload.
- **Request-level tool filtering:** Bootstrap only rewrites the target request's provider payload; it does not modify Pi's global active tools. Both direct `name` and OpenAI `function.name` tool definitions are supported. If the payload has no recognizable `tools` array or is missing `bash`/`read`, the extension warns and fails open to the original payload. If the model hallucinates a call to a hidden global tool, the extension blocks execution across the entire bootstrap response batch.
- **Branch semantics:** Promotion is append-only for the whole session. Once a promotion signal appears in any branch in `getEntries()`, the current session stays promoted even after leaving that branch via `/tree`; a new fork is re-evaluated from the durable entries copied into the new session.
- **Experimental boundary:** This strategy mirrors the two-phase logic of `pi-ds-anchored` / `dsh-anchored-standard`; it does not guarantee benefits for other models, providers, tasks, or Pi versions.
- **Trust boundary:** The extension retains `bash`, so it has the same permissions as the Pi shell tool. Review the source before installing.

## Compatibility

Development and verification targets:

- Pi `0.84.2`
- Node.js `>=22.19.0`
- macOS/Linux Pi built-in `bash` and `read`

Pi currently provides a unified `bash` tool; this extension does not select `pwsh` on Windows like the DeepSeek Harness version. If the target Pi build lacks `bash`, the extension fails open to the original active catalog and warns.

The extension makes no network requests, runs no extra commands, and adds no telemetry.

## License

MIT. Design origins and name attributions are in [`NOTICE`](./NOTICE).
