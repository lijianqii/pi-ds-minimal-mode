# ds-minimal-mode — Pi Coding Agent 插件

一个 [Pi coding agent](https://github.com/earendil-works/pi) 扩展，对齐 [DeepSeek Harness 极简模式](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/config/agent-presets/minimal/agent.cordis.yml)，**仅当当前模型为 `deepseek-v4-flash` 或 `deepseek-v4-pro` 时生效**；其它模型下插件完全透明（用 Pi 默认提示词、默认工具描述、不限制工具）。

当当前模型是目标模型时：

1. **目标模型下全时固定系统提示词**为项目工程化 persona（见 `FIXED_SYSTEM_PROMPT`，五阶段工程流程）；只要当前模型是目标模型，每一次请求都用该提示词，**并非仅首轮**。切到非目标模型时恢复 Pi 默认。

2. **覆盖内置 `read` 与 `bash` 的描述**，对齐 DeepSeek 极简模式：
   - `bash`：直接采用极简模式 `persistent-bash` 的描述原文。
   - `read`：DeepSeek 极简模式没有独立 read 工具（它用 `str_replace_editor` 的 `view` 读文件），故把 Pi 的 `read` 描述对齐到 `view` 语义（`cat -n` 行号、目录列出、行范围、截断）。执行逻辑不变，只改模型可见的描述。

3. **首次（目标模型的）请求只暴露 `bash`**；该请求结束后，后续所有请求放开全部可用工具。

切到非目标模型时：read/bash 描述立即恢复 Pi 内置默认，工具限制立即解除，系统提示词恢复 Pi 默认。

## 工作原理

模型判定：`isTargetModel(model)` 检查 `model.id`（小写）是否匹配 `TARGET_MODEL_IDS`（用 `includes` 兼容版本后缀）。当前模型由 `ctx.model`（各事件上下文）和 `model_select` 事件的 `event.model` 提供。

首次请求的工具限制在**多个钩子反复强制**（仅目标模型 + 首次未完成时）：

| 事件 | 行为 |
|------|------|
| `session_start` | 重置"首次"标记；按当前模型同步 read/bash 描述；若为目标模型则限制为 `["bash"]` |
| `model_select` | 按新模型切换 read/bash 描述（目标→DeepSeek 版，非目标→内置版）；目标且首次未完成则限制，否则放开全部 |
| `before_agent_start` | 目标模型 → 每轮都把系统提示词固定为项目 persona（全时生效），且首次未完成时再强制 `bash`；非目标模型不干预（提示词用 Pi 默认） |
| `turn_start` | 目标模型且首次未完成 → 第三次强制 `bash` |
| `turn_end` | 首个**目标模型且成功完成**的 turn_end（`stopReason` 非 `error`/`aborted`）→ 置 `firstRequestDone=true`，放开全部工具（非目标模型的 turn、以及首轮**失败**的 turn 都不改变状态） |

> 设计要点：
> - 非目标模型的请求不会把 `firstRequestDone` 置位，因此"先用非目标模型聊几句，再切到目标模型"时，目标模型的第一次请求仍会触发 bash 限制。
> - 首轮请求若因网络超时 / 模型不可用 / 用户中断而失败（provider 把失败编码为 `stopReason="error"` 或 `"aborted"` 的 assistant 消息），`turn_end` 不会置位 `firstRequestDone`，也不放开工具；重试时仍走 bash-only + 固定 persona，不会静默退回未加载插件的默认环境。

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

也可通过 pi 包安装（仓库已含 `package.json` 的 `pi` manifest）：
```bash
pi install git:github.com/lijianqii/pi-ds-minimal-mode
```

## 验证

1. 切到 `deepseek-v4-flash` 或 `deepseek-v4-pro`（`/model` 或 Ctrl+P），会看到 `ds-minimal-mode active.`，以及 `First request restricted to: bash`
2. 第一次提问，模型只能调用 `bash`（描述为 DeepSeek 极简模式版本）
3. 第一轮结束后看到 `First request complete — all tools enabled.`
4. 之后可使用 `read`、`edit`、`write`、`grep`、`find`、`ls` 等全部工具（`read`/`bash` 仍是 DeepSeek 描述版）
5. 切到其它模型 → 看到 `ds-minimal-mode inactive (non-target model).`，系统提示词与工具描述恢复 Pi 默认
6. 系统提示词：目标模型下每次请求都是项目工程化 persona（五阶段流程），切到其它模型恢复 Pi 默认；可用 `/system` 确认

## 自定义

- 想改生效模型：修改 `TARGET_MODEL_IDS`（默认 `["deepseek-v4-flash","deepseek-v4-pro"]`）。匹配用 `id.includes(t)`，如需精确匹配可改成 `id === t`。
- 想改首次暴露的工具：修改 `FIRST_REQUEST_TOOLS`（默认 `["bash"]`）。
- 想改固定提示词：修改 `FIXED_SYSTEM_PROMPT`。
- 想改 `read`/`bash` 的对齐描述：修改 `DEEPSEEK_READ_DESCRIPTION` / `DEEPSEEK_BASH_DESCRIPTION`。
- 想"放开"时只恢复到用户配置的默认工具集（而非全部工具）：把 `turn_end` 里的 `pi.setActiveTools([...new Set(allTools)])` 换成恢复你在 `session_start` 中预先保存的默认集即可。
- 不想要通知提示：删掉各处 `ctx.ui.notify(...)` 调用。

## 依赖

无需额外 npm 依赖。`@earendil-works/pi-coding-agent`（含 `createBashTool`/`createReadTool` 与类型）由 Pi 运行时自动提供。
