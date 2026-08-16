# ds-minimal-mode — Pi Coding Agent 插件

一个 [Pi coding agent](https://github.com/earendil-works/pi) 扩展，对齐 [DeepSeek Harness 极简模式](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/config/agent-presets/minimal/agent.cordis.yml)，**仅当当前模型为 `deepseek-v4-flash` 或 `deepseek-v4-pro` 时生效**；其它模型下插件完全透明（用 Pi 默认提示词、默认工具描述、不限制工具）。

当当前模型是目标模型时：

1. **系统提示词始终固定**为 `You are a helpful software engineer assistant.`
   （正是 DeepSeek 极简模式 persona 的完整文本）每一轮都用这句，覆盖 Pi 内置提示词、AGENTS.md、skills 等所有来源。

2. **覆盖内置 `read` 与 `bash` 的描述**，对齐 DeepSeek 极简模式：
   - `bash`：直接采用极简模式 `persistent-bash` 的描述原文。
   - `read`：DeepSeek 极简模式没有独立 read 工具（它用 `str_replace_editor` 的 `view` 读文件），故把 Pi 的 `read` 描述对齐到 `view` 语义（`cat -n` 行号、目录列出、行范围、截断）。执行逻辑不变，只改模型可见的描述。

3. **首次（目标模型的）请求只暴露 `read` 和 `bash`**；该请求结束后，后续所有请求放开全部可用工具。

切到非目标模型时：read/bash 描述立即恢复 Pi 内置默认，系统提示词不再固定，工具限制立即解除。

## 工作原理

模型判定：`isTargetModel(model)` 检查 `model.id`（小写）是否匹配 `TARGET_MODEL_IDS`（用 `includes` 兼容版本后缀）。当前模型由 `ctx.model`（各事件上下文）和 `model_select` 事件的 `event.model` 提供。

首次请求的工具限制在**多个钩子反复强制**（仅目标模型 + 首次未完成时）：

| 事件 | 行为 |
|------|------|
| `session_start` | 重置"首次"标记；按当前模型同步 read/bash 描述；若为目标模型则限制为 `["read","bash"]` |
| `model_select` | 按新模型切换 read/bash 描述（目标→DeepSeek 版，非目标→内置版）；目标且首次未完成则限制，否则放开全部 |
| `before_agent_start` | 目标模型且首次未完成 → 再次强制 `read + bash`；目标模型时把系统提示词设为固定值（非目标不干预） |
| `turn_start` | 目标模型且首次未完成 → 第三次强制 `read + bash` |
| `turn_end` | 首个**目标模型**的 turn_end → 置 `firstRequestDone=true`，放开全部工具（非目标模型的 turn 不改变状态） |

> 设计要点：非目标模型的请求不会把 `firstRequestDone` 置位，因此"先用非目标模型聊几句，再切到目标模型"时，目标模型的第一次请求仍会触发 read+bash 限制。

## 安装

任选一种方式：

**全局（所有项目生效）**
```bash
mkdir -p ~/.pi/agent/extensions
cp ds-minimal-mode.ts ~/.pi/agent/extensions/ds-minimal-mode.ts
```

**项目本地（仅当前项目）**
```bash
mkdir -p .pi/extensions
cp ds-minimal-mode.ts .pi/extensions/ds-minimal-mode.ts
```

> 项目本地的 `.pi/extensions` 需要先用 `/trust` 信任当前项目目录后才会加载。

**临时测试（不安装）**
```bash
pi -e ./ds-minimal-mode.ts
```

安装到自动发现目录后，可用 `/reload` 热重载，无需重启。

## 验证

1. 切到 `deepseek-v4-flash` 或 `deepseek-v4-pro`（`/model` 或 Ctrl+P），会看到 `ds-minimal-mode active.`，以及 `First request restricted to: read, bash`
2. 第一次提问，模型只能调用 `read` / `bash`（描述为 DeepSeek 极简模式版本）
3. 第一轮结束后看到 `First request complete — all tools enabled.`
4. 之后可使用 `edit`、`write`、`grep`、`find`、`ls` 等全部工具（`read`/`bash` 仍是 DeepSeek 描述版）
5. 切到其它模型 → 看到 `ds-minimal-mode inactive (non-target model).`，系统提示词与工具描述恢复 Pi 默认
6. 系统提示词（目标模型下）恒为 `You are a helpful software engineer assistant.`，可用 `/system` 确认

## 自定义

- 想改生效模型：修改 `TARGET_MODEL_IDS`（默认 `["deepseek-v4-flash","deepseek-v4-pro"]`）。匹配用 `id.includes(t)`，如需精确匹配可改成 `id === t`。
- 想改首次暴露的工具：修改 `FIRST_REQUEST_TOOLS`（默认 `["read","bash"]`）。
- 想改固定提示词：修改 `FIXED_SYSTEM_PROMPT`。
- 想改 `read`/`bash` 的对齐描述：修改 `DEEPSEEK_READ_DESCRIPTION` / `DEEPSEEK_BASH_DESCRIPTION`。
- 想"放开"时只恢复到用户配置的默认工具集（而非全部工具）：把 `turn_end` 里的 `pi.setActiveTools([...new Set(allTools)])` 换成恢复你在 `session_start` 中预先保存的默认集即可。
- 不想要通知提示：删掉各处 `ctx.ui.notify(...)` 调用。

## 依赖

无需额外 npm 依赖。`@earendil-works/pi-coding-agent`（含 `createBashTool`/`createReadTool` 与类型）由 Pi 运行时自动提供。
