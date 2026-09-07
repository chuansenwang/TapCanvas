# DeepSeek Harness 上游同步可行性研究

## 结论

可以把 `apps/agents` 更新到 DeepSeek Harness 上游版本，但不适合直接用上游目录覆盖。当前本地运行时是经过 TapCanvas 定制的独立副本；正确路径是“锁定上游快照、生成差异、逐项重放 TapCanvas 定制、再做构建与集成验证”。在用户明确确认覆盖范围前，不执行删除、批量覆盖或版本切换。

## 上游事实

- 上游仓库：<https://github.com/deepseek-ai/deepseek-harness>
- `master` 最新提交（2026-09-04）：`d347e703908d0406b7a7ef80e3a0e594d86b2215`。
- 官方 Atom 提交源显示该提交合并了 `release: dsh@0.1.3-alpha.1`。
- 上游 `package.json` 版本为 `0.1.3-alpha.1`；上游 `README.zh.md` 明确写明 Harness 仍处于“开发者预览”，未来会有破坏性变更。
- 直接证据：上游提交 Atom <https://github.com/deepseek-ai/deepseek-harness/commits/master.atom>；上游源码清单 <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/package.json>；发行说明 Atom <https://github.com/deepseek-ai/deepseek-harness/releases.atom>。

## 本地基线

- 仓库当前 HEAD：`c1a9c81107d8f870527b4fe142deacfbc8b6ebef`，提交时间 2026-09-05 21:08（提交信息：`本地ComfyUI`）。
- `apps/agents/package.json`：`@tapcanvas/agents`，版本 `0.1.2-alpha.4`。
- `third-party/deepseek-harness/package.json`：`@deepseek-ai/dsh-root`，版本 `0.1.2-alpha.4`。
- 根目录 ADR《采用 Harness 作为 TapCanvas 唯一智能体运行时》规定：`apps/agents` 是唯一运行时，`third-party/deepseek-harness` 只是迁移验收前的来源副本，后续不做自动上游同步。
- 本地 `apps/agents` 近期提交包括 `集成herness` 与 `本地ComfyUI`，说明该目录已不是未经修改的上游工作区。

## 差异测量

我下载了上游 `d347e703…` 的源码压缩包到系统临时目录，只读比较 `third-party/deepseek-harness` 与该快照；排除了 `node_modules`、`lib`、`dist`、`.dsh-build`、覆盖率、缓存、`*.tsbuildinfo` 和 source map。结果为：上游 9,069 个文件，本地 8,843 个文件，文件内容或存在性差异 2,226 项；上游独有 423 项，本地独有 197 项。压缩包中的少量 Windows 不可创建的符号链接文件未参与该比较，因此该数字用于判断量级，不作为逐文件补丁清单。

这说明当前版本差异同时包含上游新功能、删除/移动、文档与测试变化，以及本地改造，不能按单个 package 版本号替换。

## TapCanvas 定制边界

`apps/agents` 中可确认的本地定制包括：

- `packages/bundle/web-app/src/tapcanvas-scope.ts`：把当前项目、流程、节点和模型目录作用域注入原生 Web 会话，并注册 `tapcanvas_*` 能力。
- `packages/bundle/web-app/src/tapcanvas-api-proxy.ts`：原生 Harness Web Server 到 Hono 的同源 API 代理。
- `packages/bundle/web-app/src/index.ts`：在单一 Origin 下托管 TapCanvas 页面并挂载上述运行时。
- `packages/client/ui-conversation/src/client/tapcanvasScope.ts`、`apply.ts` 及对应测试：浏览器会话与 TapCanvas 作用域同步。
- `.agents/skills/tapcanvas-*`：TapCanvas 原生工具、分镜连续性、工作流编排和提示词 specialist 约束；这些是运行时技能来源，不应被上游覆盖。
- `package.json`、发布脚本和若干校验脚本：根包改名为 `@tapcanvas/agents`，并保留 TapCanvas 的构建/发布边界。

ComfyUI 的近期修改主要落在根仓库的 `apps/hono-api`、`apps/web` 和资源文件；但这不降低 `apps/agents` 覆盖风险，因为 Harness 运行时仍依赖上述同源代理、作用域协议和技能目录。

## 直接覆盖风险

1. 覆盖 `apps/agents` 会丢失 TapCanvas 作用域桥接、Hono 代理、原生工具注册和技能约束，导致页面能启动但无法读取/操作当前画布，或重新出现跨 Origin 链路。
2. 上游已从 `0.1.2-alpha.4` 前进到 `0.1.3-alpha.1`，且发行说明包含 Web 文件附件、代理环境变量、模型探测等变化；这些变化可能修改会话事件、Web 协议、配置目录和快照，不能只改根版本字段。
3. 上游 Harness 明确处于开发者预览阶段并允许破坏性变更；本地 `@tapcanvas/agents` 的包名、脚本、构建产物和路径是本地发布约定，直接同步会造成 workspace、lockfile、入口和文档不一致。
4. 仓库强制要求同步原生 Agent skill、`apps/hono-api/README.md` 的 AI 对话架构章节、工具 schema 与交付验收链路；上游文件覆盖不会自动满足这些约束。

## 推荐更新策略

### 阶段一：只读基线与快照

记录上游提交 `d347e703…`、上游版本 `0.1.3-alpha.1`、本地 HEAD 和当前定制文件清单；为更新建立独立工作区或临时目录，不改当前运行时。

### 阶段二：选择性合并

以上游 `packages/`、`apps/cli`、`apps/web` 和测试变更为候选，逐块应用到 `apps/agents`；保留 TapCanvas 的 `tapcanvas-*` 模块、作用域协议、同源代理、技能和包名。对上游删除/重命名先做人工映射，不采用整目录复制。

### 阶段三：依赖与生成物同步

统一所有 Harness 包版本，更新 `apps/agents/pnpm-lock.yaml`，重新生成 catalog、第三方许可证清单、类型与构建产物。若上游改动会话/协议/schema，必须同步对应中文 skill、工具 schema、前端结构校验与 Hono 架构文档。

### 阶段四：验证后再切换

至少执行 `pnpm --dir apps/agents run typecheck`、定向 Harness Web/会话测试、TapCanvas Web 与 Hono 集成测试，以及同源登录、作用域读取、工具调用、会话恢复和 ComfyUI 任务回归。所有失败必须显式记录，不添加默认模型、默认 route 或静默降级。

### 阶段五：明确确认后落地

只有在差异审阅和测试通过、并得到用户对覆盖/删除范围的明确确认后，才把选择性同步结果写回 `apps/agents`；不删除 `third-party/deepseek-harness`，除非另行确认迁移验收完成。

## 最终判断

“更新”技术上可行，但当前证据不支持直接覆盖。建议先做一次选择性上游同步评估，预估会涉及 2,000 级别文件差异、依赖锁定、协议/快照和 TapCanvas 定制重放；若目标只是获得上游某个具体修复，应优先定位对应提交并移植最小补丁，而不是整体升级。

