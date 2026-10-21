# DeepSeek Harness Code Wiki

> 本文档是对 DeepSeek Harness 仓库的结构化代码 Wiki，覆盖整体架构、模块职责、关键类与函数、依赖关系与运行方式。所有条目均基于当前代码核实；权威细节以文中链接的仓库文档与源码为准。
>
> 适用版本：`0.2.1-rc.2`（根 `package.json`） · 许可证：MIT · 运行时：Node.js `^22.19 || >=24` · 包管理：pnpm `11.28.5`（Corepack）

## 目录

- [1. 项目概述](#1-项目概述)
- [2. 整体架构](#2-整体架构)
  - [2.1 设计哲学：一切皆插件](#21-设计哲学一切皆插件)
  - [2.2 Cordis 框架基础](#22-cordis-框架基础)
  - [2.3 Profile / Bundle / Patch 组合模型](#23-profile--bundle--patch-组合模型)
  - [2.4 能力接缝（Capability Seam）](#24-能力接缝capability-seam)
  - [2.5 Turn / Step 执行流](#25-turn--step-执行流)
  - [2.6 事件体系](#26-事件体系)
- [3. 仓库布局](#3-仓库布局)
- [4. 主要模块与职责](#4-主要模块与职责)
  - [4.1 core — 产品 API 主干](#41-core--产品-api-主干)
  - [4.2 llm — 模型调用能力族](#42-llm--模型调用能力族)
  - [4.3 执行域 — shell / fs / subprocess / sandbox / terminal / ssh / ptc-runtime / lsp](#43-执行域--shell--fs--subprocess--sandbox--terminal--ssh--ptc-runtime--lsp)
  - [4.4 模型工具与扩展能力族](#44-模型工具与扩展能力族)
  - [4.5 会话与数据面](#45-会话与数据面)
  - [4.6 应用栈 — boot / bundle / host / client / api / typert / sdk / acp](#46-应用栈--boot--bundle--host--client--api--typert--sdk--acp)
  - [4.7 apps — 可执行应用](#47-apps--可执行应用)
- [5. 关键类与函数说明](#5-关键类与函数说明)
- [6. 依赖关系](#6-依赖关系)
- [7. 运行方式](#7-运行方式)
- [8. 测试与质量门禁](#8-测试与质量门禁)
- [9. 权威文档导航](#9-权威文档导航)

-----

## 1. 项目概述

DeepSeek Harness（`dsh`）是 DeepSeek AI 开发的开源 Agent Harness（代理运行框架），基于 **"Everything is a Plugin"** 架构，底层由插件框架 [Cordis](https://github.com/cordiverse/cordis) 驱动。产品形态包括：

- **Web GUI**（`dsh web`，默认 `http://127.0.0.1:3080`）：浏览器端聊天与工作台界面。
- **Headless 一次性运行器**（`dsh --profile headless "task"`）：无服务器的一次性 Agent 任务执行。
- **SDK**（`dsh --profile sdk` / `sdk-minimal`）：进程外 JSON-RPC 服务，供 TypeScript SDK 与 Python SDK（`python/`）调用。
- **ACP**（`dsh --profile acp`）：面向自动化客户端的 Agent Client Protocol 服务器。
- **Desktop**（Electron 桌面应用，`apps/desktop`）：打包完整 dsh Web 应用的桌面壳。

项目处于 **developer preview** 阶段，公开 API 均为 pre-stable，存在兼容性破坏变更（升级记录见 `docs/upgrade-guide/`）。

| 属性 | 值 |
|---|---|
| 语言 | TypeScript（全 ESM，`"type": "module"`，strict 编译） |
| 框架 | Cordis `4.0.0-rc.7`（vendored 于 `vendor/cordis`，rescope 为 `@deepseek-ai/cordis`） |
| 构建 | tsc（`lib/types` 声明）+ tsdown（运行时 bundle）+ Vite（Web 前端） |
| 测试 | Vitest（单测 / 覆盖率 / e2e / 快照 / Web e2e 多套配置） |
| 前端 | React 18 + Vite（`apps/web`），CSS Modules |
| 持久化 | JSONL(+zstd) 会话日志、SQLite（检索 / 存储） |
| 包命名 | `@deepseek-ai/dsh-<pkg>`，按能力族分组于 `packages/<group>/<pkg>/` |

-----

## 2. 整体架构

权威总览：[docs/architecture.md](docs/architecture.md)（改动 `packages/` 前必读）。配套图：[docs/agent-lifecycle.md](docs/agent-lifecycle.md)（时序图）、[docs/capability-seams.md](docs/capability-seams.md)（接缝图）。

### 2.1 设计哲学：一切皆插件

产品中每个部件——模型适配器、工具注册表、会话日志、Agent 循环本身——都是 Cordis 插件，均可通过配置替换。不存在需要 patch 的特权核心：扩展 dsh 的方式就是**把一个插件挂载到其他插件旁边**。

### 2.2 Cordis 框架基础

详见 [docs/cordis-primer.md](docs/cordis-primer.md)。五个核心概念：

1. **插件（Plugin）**：实现了 Service 协议的对象——可以是带 `inject` / `apply(ctx)` 字段的函数插件，也可以是 `Service` 子类（默认导出服务类）。注意：函数插件命名导出 `name`/`inject`/`Config`/`apply` 且**不能**有 default export，两种形态混用会导致 Loader 丢弃命名空间（见 `packages/AGENTS.md`）。
2. **Context（上下文）**：服务的仓库。服务通过声明合并占据稳定的 `ctx.<key>`（如 `ctx.tools`、`ctx.llm`、`ctx.sessions`），其他插件按键查找服务而非导入具体实现。
3. **`inject` 声明依赖**：插件命名所需服务，等其就绪后再激活——加载顺序由服务需求表达，而非手工编排。
4. **类型化事件**：通过 TypeScript declaration merging 声明事件名，按 `emit`（观察）/ `waterfall`（包装，监听器必须调用 `next()` 委托，否则短路）/ `parallel`（并行）/ `serial`（串行）/ `bail`（首个拒绝即停）五种模式分发。每个事件用 `@mode` 标注分发模式。
5. **注册即效果（Registrations are effects）**：prompt section、工具 schema、适配器、监听器等一律通过 `ctx.effect()` / `ctx.on()` 安装，`register()` 返回 disposer，插件卸载/HMR 时可逆地回卷。

### 2.3 Profile / Bundle / Patch 组合模型

一个运行中的 `dsh` 是启动时由**有序层**组合出的插件树：

- **Profile（档案）**：存储在 Harness Home 中的命名组合，列出其堆叠的 bundle、树外插件与用户 `cordis.patch.yml`。出厂模板：`web`、`headless`、`sdk`、`sdk-minimal`、`acp`。在 `package.json` 的 `dsh.profile` 字段声明。
- **Bundle（捆绑包）**：Cordis 配置行及其挂载代码的分发格式，在 `package.json` 的 `dsh.bundle` 字段指向 patch 文件（`cordis.patch.yml`）。`dsh-base` 是 `web/headless/sdk/acp` 共享的第一层（模型适配器、工具、持久化、沙箱与审批策略、设置、凭证、遥测）；`dsh-web-app` 加浏览器应用，`dsh-headless` 加一次性 runner，`dsh-sdk-app` 加 SDK JSON-RPC 服务器，`dsh-acp-app` 加 ACP 服务器；`dsh-sdk-minimal` 是唯一不套 `dsh-base` 的独立 bundle。
- **Patch（补丁）**：按行 id 定位并整体替换该行配置，或插入新行。层级从底到顶：profile 的有序 bundle 层 → profile 用户层 → `$DSH_HOME/cordis.patch.yml` → `--patch` 覆盖层（见 [apps/cli/src/profile-boot.ts](apps/cli/src/profile-boot.ts)）。
- **HMR**：YAML 控制热更新——base 启用 config-only 的 `dsh-hmr`；headless/SDK/ACP 禁用；`sdk-minimal` 不含。

查看本机实际启动树：`dsh --profile web --dump-config`（实现见 [apps/cli/src/dump-config.ts](apps/cli/src/dump-config.ts)）。

### 2.4 能力接缝（Capability Seam）

**接缝**是可替换的能力，由三个角色构成：**Service Definition**（声明接口的包，占据 `ctx` 键）、**Service Provider**（实现它）、**Consumer**（使用它，通常是模型工具）。一个包可兼任多角色，但单角色不构成接缝。接缝是"换一个 Provider 即换掉整个产品行为"的原因：例如 `fs` 与 `subprocess` 的 Provider 共享同一个执行世界（execution world），把它们指向远程沙箱时 Bash、PTY、LSP 一起迁移，无需分叉 Provider。完整图见 [docs/capability-seams.md](docs/capability-seams.md)。

### 2.5 Turn / Step 执行流

**Step** = 一次模型请求及其调用的工具；**Turn** = 零或多个 Step。核心序列（摘自 [docs/architecture.md](docs/architecture.md)）：

```text
turn/start
  claim next-step input plus one queued message
  assemble prompt sections + tool schemas
  -> agent/pre-step                    （决定接受哪些输入，可改写/拒绝）
     step/start
     agent/request -> prepareCall      （取消时不提交 system/users）
     derive and freeze model history from the log
     stream the bound prepared call -> llm/stream -> agent/assistant-stream
       agent/assistant-stream chunk*
       assistant/message | assistant/attempt -> agent/assistant-stream end
     tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute -> tool/result*
     step/end
     tools owe another request, or next-step input arrived -> next step
  -> agent/turn-stopping
turn/end
```

要点：

- `turn/*`、`step/*`、`system/message`、`user/message`、`assistant/message`、`assistant/attempt`、`tool/*` 是**持久 session 事件**；`agent/pre-step`、`agent/request`、`llm/stream`、`tools/*` 是**活扩展点**（waterfall，监听器必须 `next()` 委托；`agent/turn-stopping` 为 serial、无 `next()`）。
- **Model-visible ⟺ logged**：每条模型请求必须能从会话日志重建；新的模型可见输入必须伴随 session 事件。
- 每条 `assistant/message` 内嵌产生它的完整紧凑定时流；`assistant/attempt` 保留失败的尝试但不进入模型历史（决策记录 `.agents/notes/implemented/architecture/2026-09-01-v2-embedded-assistant-streams.md`）。
- 系统提示词以 `system/message` 历史形式随日志传输（surface node 决策，见 `packages/core/agent-loop/README.md`）。

### 2.6 事件体系

三个事件域（生产者/消费者全表见 [docs/event-producer-consumer.md](docs/event-producer-consumer.md)）：

| 域 | 示例 | 用途 |
|---|---|---|
| Session 事件（持久） | `session/event`、`turn/start`、`user/message`、`tool/call`… | 必须在重载后存活的事实，追加进日志并广播 |
| Agent 事件（活） | `agent/created`、`agent/pre-step`、`agent/request`、`agent/assistant-stream`、`agent/request-error`、`agent/turn-stopping` | 观察/拦截进行中的工作，携带活 `Agent` |
| 能力事件（活） | `fs/*`、`tools/*`、`telemetry/*`、`llm/stream` | 为接缝附加策略与适配器，不导入循环 |

-----

## 3. 仓库布局

```text
vendor/      Vendored Cordis 框架与基础库（清单见 vendor/README.md，rescope 为 @deepseek-ai/*）
packages/    @deepseek-ai/dsh-<pkg> 工作区包，位于 packages/<group>/<pkg>/
  core/                 agent/session API 主干
  api/                  远程 BFF（网关与各 controller）
  typert/               类型图生成、artifact 加载、运行时注册表
  llm/                  模型 Provider 与适配器
  shell/                命令执行
  subprocess/           子进程管理
  ssh/                  SSH 执行 Provider 族
  terminal/             持久终端（PTY）
  ptc-runtime/          PTC 执行
  sandbox/              进程 confinement
  deliverables/         回合交付物
  fs/                   文件系统访问
  lsp/                  语言服务器
  skill/                技能加载
  web/                  搜索/抓取工具
  computer-use/         桌面交互
  browser-use/          浏览器交互
  compaction/           上下文压缩
  context/              请求上下文
  subagent/             委派 Agent
  jobs/                 后台任务
  bundle/               profile 捆绑层
  workflow/             工作流执行
  todo/                 todo_write 工具
  plan/                 计划协作
  goal/                 会话目标
  schedule/             定时跟进
  preset/               Agent 组合
  guard/                循环/工具防护
  extensions/           运行时自修改
  session/              持久会话
  session-query/        会话检索/搜索/导出
  attachment/           二进制附件
  spill/                输出外溢
  storage/              非会话存储
  workspace/            工作区实体
  feedback/             人类反馈
  identity/             匿名身份
  settings/             用户设置
  credentials/          凭证/授权
  acp/                  自动化 ACP
  interaction/          人机协作（审批/提问）
  boot/                 应用启动胶水
  sdk/                  JSON-RPC SDK
  host/                 Web GUI 宿主服务
  client/               Web GUI 浏览器端
  mcp/                  外部 MCP 工具
  experimental/         评估中的能力（无产品支持承诺）
  test-support/         测试基础设施
  util/                 零依赖工具（Branded、home 路径、超时等）
python/      Python SDK/运行时（python/README.md）
native/      @deepseek-ai/node-addon-system 原生插件源码
apps/        cli（dsh CLI）、web（Vite 前端）、desktop（Electron）、desktop-host、plugin-market-generator
benchmarks/  性能门禁
.agents/     Agent 工作流/决策笔记（notes/）、技能（skills/）
docs/        文档（docs/AGENTS.md 定义标准）
scripts/     门禁与生成器
website/     VitePress 文档站点投影
```

-----

## 4. 主要模块与职责

包组权威地图：[packages/README.md](packages/README.md)；各组 README 是该族的权威包清单。

### 4.1 core — 产品 API 主干

| 包 | 职责 | `ctx` 键 |
|---|---|---|
| `core/session` | 追加式 `SessionEvent` 日志与内存存储 | `ctx.sessions` |
| `core/system-prompt` | Prompt section 与工具 schema 组装 | `ctx.systemPrompt` |
| `core/tools` | 带作用域的工具注册表与带护栏的执行管道 | `ctx.tools` |
| `core/agent` | `Agent` 接口、活注册表与 `agent/*` 事件 | `ctx.agents` |
| `core/agent-loop` | 实现该接口的默认驱动 | `ctx.agentLoop` |
| `core/scope` | per-agent 作用域注册原语 | 库，无键 |

- **session**：`SessionEventMap` 定义于 [packages/core/session/src/types.ts](packages/core/session/src/types.ts)，核心持久事件包括 `turn/start`、`turn/end`、`step/start`、`step/end`、`system/message`、`user/message`、`developer/message`、`assistant/message`、`assistant/attempt`、`tool/call`、`tool/result`、`request/header`、`request/context`。服务暴露 `session/created`、`session/disposed`、`session/event`、`session/flush` 事件（[src/index.ts](packages/core/session/src/index.ts)）。模型历史投影：`Session.deriveMessages()`（[src/index.ts:984](packages/core/session/src/index.ts)）与 `deriveEventMessage()`（[src/surface.ts](packages/core/session/src/surface.ts)）。
- **agent**：[packages/core/agent/src/index.ts](packages/core/agent/src/index.ts) 定义 `AgentFactory`（agent/session 创建与恢复契约）、`AgentRegistry`（`ctx.agents` 实现，维护活 agent、initiator 链、factory 绑定）、`AgentHandle`（持有 `Agent` 并提供 `dispose()` 的拥有型句柄）与 `Agent` 本体。
- **agent-loop**：`AgentLoop` 类扩展 Cordis `Context` 并注册 `ctx.agentLoop`（[src/index.ts](packages/core/agent-loop/src/index.ts)）；主驱动流程在 [src/agent.ts](packages/core/agent-loop/src/agent.ts)（组装 prompt、`agent/pre-step`、写入 `turn/*`/`step/*`）；工具调用/结果落盘在 [src/tool-calls.ts](packages/core/agent-loop/src/tool-calls.ts)。
- **tools**：`ToolDefinition` 继承 `ToolSchema`，附加 `output`、`execute()`、`projectContent?`、`finalizeContent?`、`timeoutMs`、`isConcurrencySafe?`、`presentCall?`、`presentResult?`（[src/index.ts](packages/core/tools/src/index.ts)）；`ToolRuntime` 服务负责注册与执行管道（`tools/pre-execute → tools/execute → tools/post-execute`），并通过 `ctx.systemPrompt.tools(...)` 把工具 schema 接入 prompt 组装。
- **system-prompt**：`SystemPrompt` 服务（[src/index.ts](packages/core/system-prompt/src/index.ts)）组装 harness identity、persona、runtime context 等 section，各插件通过注册 section 贡献提示词。
- **scope**：scoped Cordis context/event 载体，是 agent 级事件隔离与注册作用域的基础原语（[src/index.ts](packages/core/scope/src/index.ts)）。

### 4.2 llm — 模型调用能力族

组文档：[packages/llm/README.md](packages/llm/README.md)；类型参考：[docs/subsystems/llm-streaming.md](docs/subsystems/llm-streaming.md)。

| 包 | 角色 | `ctx` 键 |
|---|---|---|
| `llm/llm` | 中立模型调用服务：流式执行一次经注册 Provider 适配器的请求；定义消息/内容块/流块词汇表与 `llm/stream` waterfall | `ctx.llm` |
| `llm/llm-deepseek` | DeepSeek 共享 Messages 协议、请求配置与模型能力 | — |
| `llm/llm-deepseek-api-key` | 官方 API-key 认证与发现 | `ctx.llm` |
| `llm/llm-deepseek-account` | 账号 token 认证、失效与发现 | `ctx.llm` |
| `llm/llm-pi-ai` | 通过 pi-ai 目录与线协议服务配置的 Provider 路由（含手写网关） | 注册到 `ctx.llm` |
| `llm/deepseek-llm-api-extensions` | 在官方 DeepSeek 请求上注册生命周期拥有的顶层字段 | `ctx.deepseekLlmApiExtensions` |
| `llm/plugin-package-inventory-deepseek` | 把活动 Loader 包清单贡献为 `dsh_plugin_packages` | — |
| `llm/llm-retry` | 按 Provider 策略在持久 agent step 边界重试失败请求 | 监听 `agent/request-error` |
| `llm/token-meter` | 从持久日志测量请求与上下文压力 | `ctx.tokenMeter` |

新增模型 Provider = 在 `ctx.llm` 注册适配器；适配器把 Provider 线协议翻译为 harness 的消息/流块词汇表。

### 4.3 执行域 — shell / fs / subprocess / sandbox / terminal / ssh / ptc-runtime / lsp

这组接缝共享"执行世界"：文件系统与子进程 Provider 指向同一世界，因此可以整体切换到远程沙箱。

| 能力族 | Service Definition | Provider 示例 | 模型工具 Consumer |
|---|---|---|---|
| shell | `shell` → `ctx.shell` | `bash-local`、`bash-sandbox`、`pwsh-*` | `tool-bash`（bash）、`tool-pwsh` |
| fs | `fs` → `ctx.fs` | `fs-local`、`fs-sandbox`；`fs-observation-policy` 提供先读后写策略（`fs/*` 事件） | `tool-fs`（`read`/`read_image`/`write`/`edit`）、`tool-fs-search`（`glob`/`grep`，打包 ripgrep）、`tool-str-replace-editor`（`view`/`create`/`str_replace`/`insert`） |
| subprocess | `subprocess` → `ctx.subprocess` | 本地进程树 Provider（local shell 经它派生） | — |
| sandbox | `sandbox` → `ctx.sandbox` | `sandbox-local`、`sandbox-policy`、`sandbox-windows-acl`；后端含 bwrap / Landlock / Seatbelt | —（Consumer 在 spawn 前包裹 argv） |
| terminal | `terminal` → `ctx.terminals` | `terminal-bash` | `tool-terminal`（experimental） |
| ssh | `ssh` → `ctx.ssh` | `fs-ssh`、`subprocess-ssh`、`sandbox-ssh` 分别映射到 `ctx.fs`/`ctx.subprocess`/`ctx.sandbox` | — |
| ptc-runtime | `ptc-runtime` → `ctx.ptcRuntime` | `ptc-runtime-node`（沙箱化 Node；实验性 Python 后端走 fd-3 协议） | PTC 模式 Consumer |
| lsp | `lsp` → `ctx.lsp` | `lsp-stdio`（通用 stdio Provider） | `tool-lsp`（代码导航） |

fs 族文件 I/O 不设超时（deadline 会杀死 OS 仍在完成的写入），取消是 syscall 边界上的尽力信号（[packages/fs/README.md](packages/fs/README.md)）。

### 4.4 模型工具与扩展能力族

| 能力族 | `ctx` 键 / 事件 | 模型工具 / 命令 |
|---|---|---|
| web | `ctx.web`（search/fetch Provider） | `tool-web`：`web_search`、`web_fetch` |
| browser-use | `ctx.browserUse`（独占命名 Provider 注册） | 实验性 Playwright MCP / Chrome DevTools MCP / Stagehand Provider 提供浏览器工具 |
| computer-use | `ctx.computerUse`（独占命名 Provider 注册） | 实验性 Cua Driver MCP/原生 Provider |
| mcp | `mcp-client` 连接外部 MCP server，暴露其 tools/instructions；`mcp-resources` 提供跨连接资源读取 | — |
| subagent | `ctx.subagents`（Provider 注册表：进程内/进程外多种实现） | `tool-subagent`、`tool-subagent-control` |
| jobs | `ctx.jobs`；`jobs-local` 实现 | `tool-jobs`：`job_kill`、`job_list`、`job_output` 等 |
| workflow | `ctx.workflowEngine`；`workflow-ptc` 经 PTC runtime 执行脚本 | `tool-workflow`：`workflow` |
| skill | `ctx.skills`；`skill-filesystem`、`skill-office` Provider | `tool-skill`：`skill` |
| guard | 监听工具管道（非独立服务） | `repeat-tool-reminder`（重复调用提醒）、`timeout-policy`（`tools/execute` 截止时间） |
| compaction | `ctx.compaction` + `ctx.toolResultPruner` | `command-compact`（`/compact`）；`compaction-basic` 自动压缩 |
| context | 请求上下文插件族 | workspace 指令、`@file`、session 引用、时间、tmux 等模型可见上下文 |
| spill | `ctx.spillStore`；`spill-local` 存储；`spill-policy` 监听 `ctx.tools` 把超大工具结果转为预览+定位符 | — |
| deliverables | `ctx.workspaceChanges` | `tool-present`（声明最终交付文件） |
| todo | — | `tool-todo`：`todo_write` |
| plan | `ctx.planMode` | `/plan` 命令 + `exit_plan_mode` |
| goal | `ctx.goals` | `tool-goal`：`get_goal`/`create_goal`/`update_goal`；`command-goal`（`/goal`） |
| schedule | Host 级定时任务持久化 | `tool-schedule`：`schedule_create/list/update/delete` |
| preset | `ctx.agentPresets`（`agent-preset-registry`） | 从 preset `cordis.yml` 组合 per-session agent |
| extensions | `tool-cordis`（只读运行时发现）、`cordis-host-runner`/`cordis-client-runner`/`ui-cordis` | Agent 运行时自修改（模型写的挂载/卸载） |
| interaction | `user-approval`（审批）、`user-questions`（提问）、`permission-presets`（权限预设）、`commands` | `tool-ask-user`：`ask_user_question`（经 `ctx.userQuestions.ask` 等待人类回答） |
| experimental | 状态独立于交付，见 [packages/experimental/README.md](packages/experimental/README.md#status) | — |

### 4.5 会话与数据面

| 包组 | 关键包 | 说明 |
|---|---|---|
| session | `session-persistence-jsonl` | `SessionPersistence` 接口（`create`/`open`/`stat`/`list`/`export`）的 JSONL(+zstd) 后端：`src/storage.ts`、`src/format.ts`、`src/generation.ts`、`src/zstd.ts`。磁盘布局 `session.vN.jsonl[.zstd]`（v0 为 `session.jsonl`），代（generation）单调递增，已提交的代路径永不改名/替换/删除 |
| session | `session-projection` | `ctx.sessionProjections`：注册 `ProjectionDefinition`（`stateSchema`/`apply`/`view`/`stateVersion`），增量折叠已提交事件；宿主消费方用 `stateOf()` 读类型化状态，载体用 `snapshot()` 批量裁剪客户端视图。Agent loop 注册共享 `turnBoundary` 状态 |
| session | `session-projection-cache`、`session-stats`、`session-turn-outline` 等 | 派生视图与统计 |
| session-query | `session-query`（`SessionCorpus` 逻辑语料，见 [src/corpus.ts](packages/session-query/session-query/src/corpus.ts)）、`session-query-sqlite`（FTS5 全文检索，schema 版本 8）、`session-log-export` 等 | 会话检索/血缘/语义过滤/SQLite 搜索/导出 |
| storage | `storage`（`ctx.storage`）、`storage-json`、`storage-sqlite`、`storage-domain` | 非会话存储枢纽 + 后端 + 校验后的 KV 域表单 |
| attachment | `ctx.attachments`、`attachment-local` | 持久图片附件，内容寻址存储于 Harness Home |
| settings | `ctx.settings` | 由插件 Config schema 生成可编辑表单，落盘到 profile patch |
| credentials | `ctx.credentials` | 凭证引用/记录接缝 + env-优先-`.env` Provider + `authorization` 人工授权流 |
| identity | `anonymous-user-id` | 每个 Harness Home 的匿名 ID，供 telemetry/feedback/请求关联 |
| telemetry | `otel` | 共享 OTel 上报通道（普通事件 + 字节受限 Session log 通道） |
| workspace | `ctx.workspaceRegistry` | 按目录组织项目与 session 的工作区实体 |
| feedback | `command-feedback`、`message-feedback` | `/feedback` 命令与 per-message 评分备注 |
| working-directory | 见 `packages/AGENTS.md` 与 devDependencies | 供给用户上下文与执行路径，不改变原项目身份/沙箱写根 |

会话数据落盘位置：`resolveDshHome()`（[packages/util/home-paths/src/index.ts](packages/util/home-paths/src/index.ts)）解析 `DSH_HOME`（默认 `~/.dsh`），sessions/profiles/settings/credentials 均在 Harness Home 之下。

### 4.6 应用栈 — boot / bundle / host / client / api / typert / sdk / acp

**boot（[packages/boot](packages/boot/README.md)）**

- `app-boot`：profile 启动共享胶水——加载 `.env`、安装 Loader fail-loud 护栏、解析配置、加载 Harness Home patch 层、驱动 Cordis Loader（[src/index.ts](packages/boot/app-boot/src/index.ts)）。
- `cmdline`：命令行参数服务。`hmr`：模块/配置监视与重载协调。`config-editor`：配置编辑。
- `plugin-manager`：插件安装/事务（经打包的 pnpm、GitHub 连接、build 审批）。`plugin-market`：插件市场检索。

**bundle（[packages/bundle](packages/bundle/README.md)）**：`base`（第一层共享栈）、`web-app`（浏览器应用 + 预设 `minimal/ptc/standard` patch）、`headless`（一次性 runner：创建/恢复 Agent、驱动任务、流式输出后退出）、`sdk-app`、`acp-app`、`sdk-minimal`。各 bundle 以 `cordis.patch.yml` 声明挂载行。

**host（[packages/host](packages/host/README.md)）— Web GUI 宿主半边**：`webserver`（Node HTTP/HTTPS 路由注册服务）、`frontend-static`（SPA dist 静态服务 + 浏览器认证）、`directory-picker(-auto/-browse/-native)`（目录选择）、`open-in-app`（外部应用打开）、`plugin-inventory`（插件清单）、`product-telemetry-otel`（产品遥测）。

**client（[packages/client](packages/client/README.md)）— 浏览器半边**：`connection`（Host HTTP 桥：`/api` 路由、连接协议、RPC host service、浏览器认证；关键文件 `src/rpc.ts`、`src/http-bridge.ts`、`src/rpc-host.ts`）、`web`（浏览器启动入口 `boot.ts`/`boot-client.ts`/`mount.ts`）、`store`/`modules`/`locale`/`resources`/`shortcuts`/`file-upload`/`product-analytics`，以及约 60 个 `ui-*` 插件（`ui-chat`、`ui-conversation`、`ui-primitives`、`ui-approval`、`ui-settings-*`、`ui-sidebar-*`、`ui-session`、`ui-trajectory`、`ui-renderer`、`ui-slots` 等）。UI 文案走类型化词典与 `t`，`verify-client-ui-i18n` 门禁拒绝硬编码文案。

**api（[packages/api](packages/api/README.md)）— 远程 BFF**：Host 服务用 `@Remote`/`@RemoteScope` 声明可调用方法，Typert 生成 Host-for-Client 类型与运行时贡献，Client 的 `api-remotes` 组合把它们装载到 `ctx.remote` 与 `agentCtx.remote`。包含 `gateway`（流协议/流服务器）、`session-controller`（会话服务：管理、历史、assistant-stream、血缘）、`workspace-controller`、`workspace-files`、`job-controller`、`terminal-controller`、`settings-controller`、`account-controller`、`remote-access`、`remotes`。

**typert（[packages/typert](packages/typert/README.md)）**：`generator`（分析 Host 类型图，生成反射 artifact 与 Remote 投影）、`protocol`、`registry`、`loader`。Typert 由 Host tsdown 插件运行，`scripts/generate-typert.ts` 可无 bundle 生成字节相同的文件。

**sdk（[packages/sdk](packages/sdk/README.md)）**：`protocol`（newline-delimited JSON-RPC over stdio 线协议，`src/transport.ts`）、`server`（JSON-RPC 服务器插件）、`client`（TypeScript 客户端：`src/client.ts`、`src/launch.ts` 解析同版本 `dsh` 依赖并选择 `sdk` profile）。Python SDK（`python/`）走同一架构：运行时 wheel 打包 `dsh` CLI，客户端以 `dsh --profile sdk` 启动。

**acp**：自动化-only 的 Agent Client Protocol 服务器包。

### 4.7 apps — 可执行应用

| 应用 | npm 名 | 说明 |
|---|---|---|
| `apps/cli` | `@deepseek-ai/dsh` | `dsh` CLI。入口 [src/bin.ts](apps/cli/src/bin.ts)（`bin.dsh = "lib/bin.js"`），按 mode 分发 `profile` / `plugin` / `dump-config` / `dump-config-schema`；`dsh <name>` 是 `--profile <name>` 简写；launcher 级参数（`--profile`、`--patch`、`--from-default-profile` 等）在 [src/args.ts](apps/cli/src/args.ts)；端到端启动 `runProfile()` 在 [src/profile-boot.ts](apps/cli/src/profile-boot.ts)（组合 patch 栈、创建 shutdown、注入 `profileContext`、加载 PluginPackages、经 `provideCmdline` 传参给 app 插件） |
| `apps/web` | `@deepseek-ai/dsh-web-frontend` | Vite 构建的 Web GUI dist（入口 `src/main.ts`），由 `dsh web` 服务 |
| `apps/desktop` | `@deepseek-ai/dsh-desktop` | Electron 桌面壳（`main = lib/main.js`）。架构：Electron 以 Node 模式启动私有 Desktop Host（`apps/desktop-host`），Host 调用共享 CLI profile runner 与完整 Web 应用；窗口加载打包的 Web 资产并等待 boot 注入后再激活 client 插件；Web 拥有 RPC 与流，Node IPC 传递 boot 注入/就绪/致命错误/关闭；默认 OS 分配端口；拥有保留的 `$DSH_HOME/profiles/desktop` |
| `apps/desktop-host` | — | Desktop 私有 Host（office 引擎、平台会话、更新任务等） |
| `apps/plugin-market-generator` | — | 插件市场目录生成器 |

-----

## 5. 关键类与函数说明

下表汇总最常打交道的核心符号（均为源码核实位置）：

| 符号 | 位置 | 职责 |
|---|---|---|
| `AgentLoop`（class, extends `Context`） | [packages/core/agent-loop/src/index.ts](packages/core/agent-loop/src/index.ts) | 默认 Agent 驱动；设置 `ctx.agents` factory，把 provider/model 变量接入 `ctx.systemPrompt`；声明 `agent-loop/config-start-failed` |
| Agent 主循环（`preStep()`/`step()` 驱动） | [packages/core/agent-loop/src/agent.ts](packages/core/agent-loop/src/agent.ts) | 组装 system prompt、处理 `agent/pre-step`、写入 `turn/start`、`step/start`、`step/end`、`turn/end`；经 `session/event` 恢复工具结果 |
| 工具调用/结果落盘 | [packages/core/agent-loop/src/tool-calls.ts](packages/core/agent-loop/src/tool-calls.ts) | 写 `tool/call` 与 `tool/result` 事件并关联 source event seq |
| `AgentFactory` / `AgentRegistry` / `AgentHandle` | [packages/core/agent/src/index.ts](packages/core/agent/src/index.ts) | agent/session 创建与恢复契约；`ctx.agents` 实现（活注册、initiator 链、factory 绑定）；创建/恢复后返回的拥有型句柄（`dispose()`） |
| `SessionEventMap` | [packages/core/session/src/types.ts](packages/core/session/src/types.ts) | 全部持久 session 事件的类型清单（读侧必填，除非信封 `ignorable: true`） |
| `Session` 服务 + `session/created` 等 | [packages/core/session/src/index.ts](packages/core/session/src/index.ts) | `ctx.sessions`；`deriveMessages(): Message[]`（index.ts:984）从日志投影模型历史 |
| `deriveEventMessage()` | [packages/core/session/src/surface.ts](packages/core/session/src/surface.ts) | 从 surface-eligible 事件（`user/message`、`system/message`、`developer/message`、`assistant/message`、`tool/result`）投影单条 LLM 可见消息 |
| `ToolDefinition` / `ToolRuntime` | [packages/core/tools/src/index.ts](packages/core/tools/src/index.ts) | 工具形态（schema + `execute()` + 展示钩子）；工具注册与 `tools/*` 执行管道 |
| `SystemPrompt` 服务 | [packages/core/system-prompt/src/index.ts](packages/core/system-prompt/src/index.ts) | prompt section 与工具 schema 组装入口 |
| scope 原语 | [packages/core/scope/src/index.ts](packages/core/scope/src/index.ts) | per-agent 作用域 context/event 载体 |
| `ctx.llm` 服务 + `llm/stream` | [packages/llm/llm/src/index.ts](packages/llm/llm/src/index.ts) | 中立模型调用；`llm/stream` waterfall 拦截/替换/重试模型流式调用 |
| `SessionPersistence`（`create`/`open`/`stat`/`list`/`export`） | [packages/session/session-persistence-jsonl](packages/session/session-persistence-jsonl/README.md) | 持久化接缝；JSONL Provider 拥有物理帧、压缩、代选择与独占发布 |
| `ctx.sessionProjections` / `ProjectionDefinition` | [packages/session/session-projection/src/index.ts](packages/session/session-projection/src/index.ts) | 增量投影注册与读取（`stateOf()`、`snapshot()`） |
| `SessionCorpus` | [packages/session-query/session-query/src/corpus.ts](packages/session-query/session-query/src/corpus.ts) | 逻辑语料：优先活 session，否则从 `sessionPersistence` 加载持久快照 |
| `runProfile()` / patch 栈组合 | [apps/cli/src/profile-boot.ts](apps/cli/src/profile-boot.ts) | bundle 层 → profile 用户层 → `$DSH_HOME/cordis.patch.yml` → `--patch` → telemetry 开关 |
| `applyEntryPatches()` / `entryListSchema` | [vendor/include/src/index.ts](vendor/include/src/index.ts) | Include 补丁算法的导出纯函数与 `!!js` YAML 方言（`dsh --dump-config` 用它精确组合而不启动树） |
| `resolveDshHome()` | [packages/util/home-paths/src/index.ts](packages/util/home-paths/src/index.ts) | 解析 `$DSH_HOME`（默认 `~/.dsh`） |
| RPC 桥（Host 侧） | [packages/client/connection/src](packages/client/connection/src/index.ts) | `/api` 路由、连接协议、RPC host service、浏览器认证 |
| SDK 线协议 / 客户端 | [packages/sdk/protocol/src/transport.ts](packages/sdk/protocol/src/transport.ts)、[packages/sdk/client/src/client.ts](packages/sdk/client/src/client.ts) | newline-delimited JSON-RPC over stdio；TypeScript SDK 启动与调用 |
| Typert 生成器 | [packages/typert/generator/src](packages/typert/generator/src/analyzer.ts) | 分析 Host 类型图 → 反射 artifact + Host-for-Client Remote 投影 |

-----

## 6. 依赖关系

### 6.1 架构规则

- **扩展插件依赖 Service Definition，绝不依赖具体 Provider**。`dsh-agent-loop` 可替换；UI/hook/工具插件依赖 `dsh-agent`。组合 bundle 可以依赖主干插件。
- 接缝按角色拆分（Service Definition / Provider / Consumer）只在角色独立演化时进行；Service Definition 要为所有现存 Consumer 设计，不让单个 Consumer 绑架契约（`packages/AGENTS.md`）。
- 可选服务用 `ctx.get(name)` 读取；`ctx.<name>` 属性代理仅用于已声明的 `inject`。
- 依赖图是**生成物**：[docs/module-graph.md](docs/module-graph.md)（`pnpm run gen-module-graph` 生成，CI 新鲜度门禁）。不要手写。
- 工作区依赖写法：DSH 包之间 `workspace:*`；vendor/native 用 `workspace:~`（允许发布范围内 patch 更新）。

### 6.2 编译面（Host / Client 双聚合）

仓库使用隔离的 Host 与 Client 聚合（[docs/development.md](docs/development.md#typescript-project-layout)）：

- `tsconfig.host.json`（Host 包、examples、tests、scripts、website）与 `tsconfig.client.json`（`packages/client/*`、`apps/web`）各自成程序；根 `tsconfig.json` 是仅引用两聚合的 solution。
- **为什么拆**：Host 与 Client 在相同的 `ctx` 键上对 cordis `Context` 做 declaration merging，同一 `ts.Program` 看到两边会冲突。三个共享叶（`host/webserver`、`compaction/compaction`、`typert/registry`）被两聚合同时引用。
- 六个包拆分 Host/Client 叶配置：`api/remotes`、`api/gateway`、`api/session-controller`、`api/workspace-controller`、`client/connection`、`session-query/session-log-export`。
- 构建流水：`build:artifacts` = 构建原生插件 → tsc Host 聚合（`lib/types`）→ tsdown Host（`DSH_BUILD_FACE=host`，内含 Typert）→ tsc/tsdown Client → Vite Web。静态分析与测试经 tsconfig `paths` 直接解析到 `src`。

### 6.3 vendor 层

`vendor/` 是 Cordis 框架与基础库的钉版源码拷贝（清单与上游 SHA 见 [vendor/README.md](vendor/README.md)）：`cordis` 4.0.0-rc.7、`loader`、`include`、`group`、`timer`、`hmr`、`logger-console`、`cosmokit`、`schemastery`。全部 rescope 为 `@deepseek-ai/*`；Harness 包通过 `peerDependencies`/`devDependencies` 声明 `@deepseek-ai/cordis`。**禁止随手编辑 `vendor/*/src`**——每处与上游的分叉都必须登记在 vendor/README.md 的 Local modifications。

### 6.4 关键运行时外部依赖（节选）

`zod`（schema）、`js-yaml`（配置）、`chokidar`/`picomatch`（vendor HMR/Include）、React 18 + Vite（前端）、`@yao-pkg/pkg`（打包）、Electron（桌面）、better-sqlite3 类 SQLite（存储/检索，见各包 README）、ripgrep（打包进 `tool-fs-search`）。完整披露见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)（`pnpm run gen-third-party-notices` 生成）。

-----

## 7. 运行方式

### 7.1 环境准备

- Node.js `^22.19 || >=24`（需开启 Node 原生 TypeScript type stripping；`pnpm run build` 会先行检查并指名原因）。
- Corepack pnpm：`corepack enable`（仓库钉 `pnpm@11.28.5`）。
- Git ≥ 2.26。Windows 建议原生工具或 WSL 2（checkout 与工具链留在同一 OS 环境）。

```sh
pnpm install        # 首次安装（postinstall 配置 Lefthook 钩子）
pnpm run typecheck  # 新 clone 后跑一次；成功即环境就绪
```

### 7.2 从 npm 运行（用户视角）

```sh
npx @deepseek-ai/dsh web    # 启动 Web UI 于 http://127.0.0.1:3080；--no-open 不开浏览器
```

### 7.3 从源码运行

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build            # 完整构建（build:artifacts + build:check 并行图）
pnpm dsh web              # 使用已构建 artifact 启动（不重建）
```

常用变体：

```sh
pnpm run build:artifacts  # 迭代时产出可运行 artifact（tsc 类型 + tsdown bundle + Web）
pnpm run build:check      # 用当前 artifact 类型检查测试/脚本程序
pnpm run start:web        # 用源启动器服务已构建 Web artifact（等同 pnpm dsh web）
pnpm run dev:web          # 构建 + 服务 + 源码改动时重建 client bundle（--skip-build 可复用）
pnpm run start:desktop / dev:desktop   # Electron 桌面（dev 使用隔离开发 Home）
pnpm dsh --profile headless "task"     # 一次性 headless Agent（需 DEEPSEEK_API_KEY）
pnpm run demo:ptc -- "task"            # PTC 模式 headless 演示
make web|dev-web|desktop|dev-desktop|build   # 同上命令；ARGS='--no-open' 透传
```

### 7.4 Profile 与插件管理

```sh
dsh --profile web                 # 选择 profile（web/headless/sdk/sdk-minimal/acp）
dsh web                           # 简写
dsh --profile web --dump-config   # 打印实际组合出的插件树（每行都可被自己的 patch 替换）
dsh plugin --profile <name> add <package>   # 安装 bundle（唯一会激活 profile 层的包形态）
```

### 7.5 环境变量与凭证

- `DEEPSEEK_API_KEY`（必填于真实 API 场景）、`DEEPSEEK_BASE_URL`（可选）；也读取仓库根 gitignore 的 `.env`。真实 API e2e 无 key 时自跳过。**绝不提交凭证。**
- `DSH_HOME`：Harness Home 根（默认 `~/.dsh`），承载 sessions/profiles/settings/credentials。
- `DSH_GATE_CONCURRENCY`、`DSH_OXLINT_THREADS`、`DSH_COVERAGE_MAX_WORKERS`：门禁并行度覆盖。

### 7.6 文档与网站

```sh
pnpm run test:docs      # 快速文档检查（不含构建）
pnpm run doc-sync       # 全量文档门禁
pnpm run website:build  # VitePress 站点构建（兼做死链检查）
```

-----

## 8. 测试与质量门禁

权威说明：[docs/testing.md](docs/testing.md)。选择覆盖改动的最小检查，CI 负责穷举覆盖与平台矩阵。

| 命令 | 用途 |
|---|---|
| `pnpm run test` | 单元测试（Vitest，fork workers） |
| `pnpm run test:coverage` | CI 覆盖率门禁：`packages/*/*/src` 每文件 100% |
| `pnpm run test:e2e` | 真实 API 测试（无 `DEEPSEEK_API_KEY` 自跳过） |
| `pnpm run test:expected` | owner-local 过程期望 |
| `pnpm run test:snapshot` | 无 key 录制会话回放（经出厂 profiles）；`-t <name>` 过滤 |
| `pnpm run test:snapshot:record` | 重录期望输出（需 key） |
| `pnpm run test:web(:ci/:perf/:stress)` | Web e2e / 性能 / 压力（需先构建） |
| `pnpm run typecheck` | 生成 Typert 契约 + 双聚合类型检查 |
| `pnpm run lint` / `duplication` | Oxlint / jscpd 克隆检测 |
| `pnpm run hygiene` | publint + workspace/package/dependency 检查 + NodeNext 消费者检查 |
| `pnpm run check:ci*` | 与 CI 同名的门禁聚合（`scripts/run-gates.ts`） |

其他硬性约定（详见根 [AGENTS.md](AGENTS.md)）：

- 模型/产品可见变更必须更新 keyless 录制会话快照；双 SDK（TS/Python）投影 loop 变更需同 PR 更新期望输出。
- 注册贡献必须通过 HMR-safety 测试证明 disposal；spec 在 fork workers 并发运行，独占端口/路径/子进程。
- `FIXME`/`TODO`/`XXX` 按紧急度标记；文件以单个换行结尾（pre-commit 门禁）。

-----

## 9. 权威文档导航

| 主题 | 文档 |
|---|---|
| 架构总览（改动 packages/ 前必读） | [docs/architecture.md](docs/architecture.md) |
| Cordis 原理 / 教程 | [docs/cordis-primer.md](docs/cordis-primer.md) · [docs/cordis-tutorial/index.md](docs/cordis-tutorial/index.md) |
| 子系统类型参考（session/tools/llm/fs 等） | [docs/subsystems/](docs/subsystems/README.md) |
| 事件生产者/消费者全表 | [docs/event-producer-consumer.md](docs/event-producer-consumer.md) |
| 能力接缝图 | [docs/capability-seams.md](docs/capability-seams.md) |
| 扩展指南（加包/加工具/加 LLM 适配器/加设置卡） | [docs/cookbook/extension-cookbook.md](docs/cookbook/extension-cookbook.md) |
| 开发者指南（构建/布局/CI） | [docs/development.md](docs/development.md) |
| 测试策略 | [docs/testing.md](docs/testing.md) |
| 防御性模式 | [docs/defensive-patterns/](docs/defensive-patterns/README.md) |
| 生成的参考目录（工具/配置/持久化/模块图/CLI help） | [docs/tool-catalog.md](docs/tool-catalog.md) · [docs/config-catalog.md](docs/config-catalog.md) · [docs/persistence-catalog.md](docs/persistence-catalog.md) · [docs/module-graph.md](docs/module-graph.md) · [docs/cli-help.md](docs/cli-help.md) |
| 会话格式与状态 | [docs/session-format-status.md](docs/session-format-status.md) |
| 术语表 | [docs/glossary.md](docs/glossary.md) |
| 包组地图 | [packages/README.md](packages/README.md) |
| 用户指南 | [docs/user/guide/index.md](docs/user/guide/index.md) |
| 仓库协作规范 | [AGENTS.md](AGENTS.md) · [CONTRIBUTING.md](CONTRIBUTING.md) |

-----

*本文档为一次性生成的分析交付物，不参与仓库文档门禁体系；如需将其纳入 `docs/` 或网站，请遵循 [docs/AGENTS.md](docs/AGENTS.md) 的 kind 体系与双语配对规则。*
