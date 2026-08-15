# pi-ds-minimal-mode

[English](./README.en.md)

这是一个实验性的 Pi 扩展，面向 **DeepSeek V4 Flash** 与 **DeepSeek V4 Pro** 的对齐轨迹测试。它会自动检查当前 `model.id`：只有 id（忽略大小写）包含 `deepseek-v4-flash` 或 `deepseek-v4-pro` 时才启用；其他模型的 system prompt 和工具目录保持不变。

目标模型的**第一次请求**使用与 DeepSeek Harness Minimal 模式一致的 system prompt，并且只暴露 `bash` 与 `read`；**后续请求**保持 Pi 当前的完整工具目录，system prompt 不变（始终保持 Minimal persona）。这样能在首请求上锚定到极简轨迹，再无缝恢复完整工具能力。

这是社区项目，不是 DeepSeek 或 Pi 官方扩展，也不代表任何官方认可或背书。

本项目的设计来源于 https://github.com/hank9999/pi-ds-anchored ，在其基础上将目标模型扩展为 Flash 与 Pro 双触发，并简化为单一晋升策略。

## 工作原理

扩展将“首次极简锚定”和“后续完整工具能力”拆开：

1. 检查当前 `model.id` 是否包含 `deepseek-v4-flash` 或 `deepseek-v4-pro`。匹配采用不区分大小写的子串判断，只检查 id，不检查 provider 或显示名称。
2. 对匹配模型，每次 agent run 都把 Pi 的 system prompt 完整替换为以下字节稳定文本：

   ```text
   You are a helpful software engineer assistant.
   ```

   该 prompt 在整个会话中保持不变。
3. 第一次目标 agent run 在 `before_provider_request` 阶段只过滤即将发送给 provider 的工具定义，仅保留 `bash` 与 `read`。Pi 的全局活动工具状态始终不变，因此请求 #1 只看到两项 API 工具，同时不会污染非目标模型。
4. 首次持久 `assistant` 消息（纯文字回复或工具调用，先到者为准）后停止过滤。请求 #2 及之后看到 Pi 原本生成的完整目录；纯文字首答不会把会话永久困在 bootstrap。
5. `session_start` 会扫描持久 session entries 来恢复阶段，因此 resume、reload 和 fork 不依赖易失内存状态。
6. 通过 `/model` 切换到非目标模型时立即停用 prompt 替换和请求过滤；切回目标模型时重新按持久 session 状态初始化。
7. 如果 `bash` 或 `read` 不存在，扩展会一次性告警并 fail-open：保留完整工具目录，而不是让请求失败。

这里的“完整目录”是 Pi 根据当前活动工具正常生成的 provider payload，不是强行启用所有已注册工具。扩展不会调用 `setActiveTools()`，因此 `--tools`、`--exclude-tools`、默认关闭的 `grep/find/ls`，以及其他扩展的动态工具策略都会被保留。

## 与 pi-ds-anchored 的差异

| 维度 | pi-ds-anchored | pi-ds-minimal-mode |
|---|---|---|
| 目标模型 | 仅 `deepseek-v4-pro` | `deepseek-v4-flash` 和 `deepseek-v4-pro` |
| 晋升策略 | 可配置（`either` / `tool-call` / `assistant-message`） | 固定为首次 assistant 回复后晋升 |
| 配置项 | `--ds-anchored-promote-on` 标志 | 无（开箱即用） |
| 首请求 | Minimal prompt + bash/read | Minimal prompt + bash/read |
| 后续请求 | 完整工具目录，Minimal prompt | 完整工具目录，Minimal prompt 不变 |

## 安装与运行

在本仓库父目录中直接试运行：

```sh
pi -e ./pi-ds-minimal-mode/extensions/ds-minimal-mode.js
```

作为本地 Pi package 安装：

```sh
pi install ./pi-ds-minimal-mode
```

项目级安装：

```sh
pi install ./pi-ds-minimal-mode -l
```

安装后可用 `pi config` 或 `pi config -l` 启用、禁用扩展。

> 扩展会自动检测 `model.id`。例如 `deepseek-v4-flash-0813`、`deepseek-v4-pro-0813` 和 `provider/DeepSeek-V4-Pro-0813` 会启用；`deepseek-chat`、其他模型或缺失 id 均不会启用。

## 验证

运行零运行时依赖测试：

```sh
cd pi-ds-minimal-mode
npm test
npm run check
```

实际请求应满足：

- 非目标 model id 不修改 system prompt 或活动工具；
- `model.id` 包含 `deepseek-v4-flash` 或 `deepseek-v4-pro` 时，请求 #1 的 API 工具目录只有 `bash` 与 `read`；
- 首次助手回复后的下一次请求停止过滤并看到 Pi 当前完整工具目录；
- 后续请求保持完整目录，system prompt 始终为 Minimal persona；
- resume 已产生回复的 session 时直接保持完整目录。

如需验证 API 级 payload，可临时加载一个记录 `before_provider_request` 的调试扩展，检查请求中的 system prompt 与 tools；不要记录 API key、用户内容或其他敏感字段。

## 重要限制

- **完整替换 system prompt：** Pi 默认指令、`AGENTS.md`/`CLAUDE.md`、skills 摘要、工具 guidance、`--system-prompt` 与 `--append-system-prompt` 都不会出现在最终 system prompt 中。这是对齐实验所需行为，不是通用编码助手的安全默认值。
- **已有会话的模型切换：** 自动检测支持 `/model` 切换，但如果切入目标模型时 session 已有 assistant 消息，持久状态会直接判定为已晋升，无法重现“首次请求锚定”。精确实验请新建空 session。
- **扩展顺序：** Pi 的 `before_agent_start` 与 `before_provider_request` handler 按加载顺序链式执行。若后加载扩展再次改写 system prompt 或工具数组，就不再是字节完全一致的 Minimal prompt/两工具目录；需要精确实验时请让本扩展最后加载，并检查实际 payload。
- **请求级工具过滤：** bootstrap 只改写目标请求的 provider payload，不修改 Pi 全局活动工具。当前兼容直接 `name` 和 OpenAI `function.name` 两类工具定义；若 payload 没有可识别的 `tools` 数组或缺少 `bash/read`，扩展会告警并 fail-open 到原 payload。若模型幻觉调用未暴露的全局工具，扩展会在该 bootstrap 响应的整批工具调用中阻止执行。
- **分支语义：** 晋升对整个 session 是 append-only 的。`getEntries()` 中任何分支一旦出现晋升信号，即使之后通过 `/tree` 离开该分支，当前 session 仍保持晋升；新 fork 则根据复制到新 session 的持久条目重新判定。
- **实验结论边界：** 该策略仿照 `pi-ds-anchored` / `dsh-anchored-standard` 的两阶段逻辑，不保证对其他模型、provider、任务或 Pi 版本有收益。
- **信任边界：** 扩展保留 `bash`，因此与 Pi shell 工具具有相同权限。安装前请自行审阅源码。

## 兼容性

开发与验证目标：

- Pi `0.84.2`
- Node.js `>=22.19.0`
- macOS/Linux 的 Pi 内置 `bash` 与 `read`

Pi 当前统一提供 `bash` 工具；本扩展不像 DeepSeek Harness 版本那样在 Windows 选择 `pwsh`。若目标 Pi 发行版没有 `bash`，扩展会 fail-open 到原活动目录并告警。

扩展不发起网络请求、不执行额外命令，也不增加遥测。

## 许可证

MIT。两阶段设计来源与名称声明见 [`NOTICE`](./NOTICE)。
