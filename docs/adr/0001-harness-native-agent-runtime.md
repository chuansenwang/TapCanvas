# 采用 Harness 作为 TapCanvas 唯一智能体运行时

TapCanvas 将 DeepSeek Harness 的完整工作区迁入 `apps/agents`，直接在其原生认证、Web Server、会话、Agent Loop、工具注册和子代理目录中整合 TapCanvas 能力；`apps/agents` 成为唯一浏览器入口和智能体运行时。旧 `apps/agents-cli` 与 Agents Bridge 源码在迁移期保留但不再作为新的小T入口，避免维护两套会话和 Agent 执行链。选择该方案是因为 Harness 已经具备所需的会话、流式聊天、工具调用和子代理能力，继续通过桥接层会重复实现运行时并引入跨 Origin 与身份同步问题。

## 后果

- `apps/agents` 保留 Harness 完整根工作区结构和 MIT/第三方版权文件，后续由 TapCanvas 维护；上游同步采用**人工确认的发布版对齐**，不建立自动同步链路（详见下节）。
- `apps/web` 继续拥有画布源码；`apps/agents` 的原生 Web Server 在开发和生产期都直接托管画布构建产物，浏览器只访问一个 Origin。开发期可运行 Vite 构建监听器更新产物，但 Vite Dev Server 不作为浏览器入口。
- Harness JSONL 保存完整工作区会话；TapCanvas 数据库只保存用户、项目、画布与会话的索引映射。
- `tapcanvas_*` 工具在 Harness 原生工具注册图中执行，通过内部接口调用 Hono 的确定性业务能力。
- 第三方来源目录只有在迁移验收通过且得到删除确认后才移除。

## 上游同步策略

`apps/agents` 是 Harness 根工作区的**受维护分叉**，不是只读镜像。同步上游时按以下约束执行，禁止把它退化成自动跟随：

- 同步目标是上游**发布 tag**（例如 `dsh-v0.1.5-rc.2`），不是 `master` 的在途提交；每次同步前先用三方合并（上游基线 tag → TapCanvas 改动 → 目标 tag）确认冲突面，冲突必须逐处人工判定，不做整目录覆盖。
- TapCanvas 自研资产属于必须保留的一等资产：`apps/agents/.agents/skills/tapcanvas-*`、`packages/bundle/web-app` 的 `tapcanvas-scope` / `tapcanvas-api-proxy`、`packages/client/ui-conversation` 的画布作用域会话绑定、嵌入式布局约束，以及三处一致的小T persona 文案。
- 上游同步必须连带完成：`pnpm-lock.yaml` 用仓库声明的 pnpm 版本重生成、构建与类型检查、受影响包的测试，以及本仓库对 `apps/agents` 的文档同步（`AI_RUNTIME_ARCHITECTURE.md`、`apps/hono-api/README.md` 的「AI 对话架构（当前）」）。
- 同步是**破坏性升级**：Harness 处于 developer preview，上游明确声明存在破坏性变更。同步后必须重跑统一 Origin 冒烟（`/`、`/agent/`、画布 SPA 深链接），确认浏览器入口仍只有 `apps/agents` 一个。
- 2026-09-15 已按此策略完成一次同步：从 `0.1.3-alpha.1` 对齐到 `dsh-v0.1.5-rc.2`（跨 1301 个上游提交）。
