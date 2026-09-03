# Harness 原生智能体收编开发计划

## 目标

将原生 Harness 完整迁入 `apps/agents`，使其成为 TapCanvas 唯一的智能体运行时、聊天工作区和工具宿主。用户从 TapCanvas 统一入口进入左侧可收起的 Harness 工作区，使用同一套原生会话、流式聊天、工具调用和子代理能力，并与当前项目画布联动。

## 已确认的设计约束

- `apps/agents` 直接作为迁入后的 Harness 根目录，不增加 `harness/`、`adapter/` 或 `tapcanvas/` 包装层。
- 迁移单位是完整 Harness 根工作区：`apps/`、`packages/`、`vendor/`、`native/`、`scripts/`、根配置、锁文件、`LICENSE` 和 `THIRD_PARTY_NOTICES.md`。
- 迁入后的工作区保持独立 pnpm 解析；TapCanvas 根脚本通过 `pnpm --dir apps/agents` 调用，不把两套同名内部包混入根依赖图。
- 新运行时正式命名为 `@tapcanvas/agents`；旧 `apps/agents-cli` 改为明确的 legacy 包名，但保留源码和手动启动能力。
- `apps/web` 继续维护画布源码；`apps/agents` 的 Web Server 是唯一浏览器 Origin，开发和生产期都直接托管画布构建产物。开发期只允许 Vite 作为构建/监听器，不作为浏览器访问入口。
- Harness 登录身份承接 TapCanvas 登录会话；工作区会话按 `userId + projectId + flowId` 作用域绑定。
- 完整会话记录使用 Harness JSONL；TapCanvas 数据库增加工作区会话索引，不复制消息正文或工具事件。
- `executionPolicy` 由前端结构化生成，默认 `autonomous`，用户可在对话界面选择；策略只对当前画布项目生效，并在回合开始时冻结。
- `autonomous` 允许项目范围内自动执行删除、覆盖、批量修改和计费生成；项目切换不会改变已运行回合的作用域。
- 同一项目读取可并行；写入按项目串行化，节点版本冲突返回明确 `canvas_conflict`。
- 不建设独立业务审计系统；仅保留现有运行时完成验收、恢复和故障定位所需的最小 trace/diagnostics。
- 旧 Agents Bridge、`/public/chat` 和 `apps/agents-cli` 在迁移期保留但不参与新的小T入口，禁止双写、静默回退和同一会话双运行时执行。
- 第三方目录在迁移验收通过前不得删除；实际删除前需要再次取得明确确认。

## 分阶段实施

### 阶段一：迁移基线与工作区隔离

1. 复制 Harness 完整根工作区到 `apps/agents`，保持原始相对目录结构和构建配置。
2. 保留并校验 MIT `LICENSE`、`THIRD_PARTY_NOTICES.md` 及依赖许可生成链。
3. 将 Harness 根包改名为 `@tapcanvas/agents`，将旧 `apps/agents-cli` 包改为明确的 legacy 名称，避免包名和启动身份冲突。
4. 调整 TapCanvas 根启动脚本和 workspace 规则，使新工作区通过 `pnpm --dir apps/agents` 独立构建和启动；不让第三方目录与新目录同时参与解析。
5. 建立新旧启动命令：默认 `pnpm dev` 启动新运行时，旧链路仅由显式 legacy 命令启动。

**门禁**：新工作区可独立安装、构建、运行 `dsh web`；旧链路仍可手动启动；依赖解析中不存在两份同名 Harness 包。

### 阶段二：统一 Origin 与身份接入

1. 在 Harness 原生 Web Server 和 frontend-static 模块中接入 TapCanvas 画布静态资源。
2. 开发和生产期都由 `apps/agents` 直接托管 `apps/web` 构建产物；开发期使用 Vite build watch 或等价构建监听器更新静态目录，浏览器通过刷新获取最新产物，不启动 Vite Dev Server 作为访问入口。
3. 保持 Harness 原生 `/api`、WebSocket、BrowserAuth 和 Host/Origin 校验，浏览器不再从 `5175` 跨端口直连 Harness RPC。
4. 将 TapCanvas 登录会话转换为 Harness 工作区身份，拒绝缺少用户或项目作用域的会话。
5. 在 Hono 数据库增加工作区会话索引及唯一约束，记录 `sessionId、userId、projectId、flowId、状态、时间字段`。

**门禁**：开发和生产均由统一 Origin 返回画布与 Harness 页面；构建产物更新后刷新可获得新版本；刷新和重新进入可以恢复正确项目会话；不同用户和项目无法读取彼此会话；退出或权限失效会阻止后续工具调用。

### 阶段三：左侧原生 Web 工作区

1. 复用 Harness 原生 `AppFrame`、会话列表、`ChatView`、会话输入和工具卡组件。
2. 在 TapCanvas 布局中增加可收起的左侧工作区入口，避免 iframe 和第二套聊天 UI。
3. 将当前画布项目、选中节点和画布变更以结构化工作区上下文注入 Harness 会话。
4. 保证会话切换、流式事件、工具状态和画布选择状态可以双向刷新，但不在 `apps/web` 重建 Agent Loop。

**门禁**：左侧工作区可展开/收起；消息流、会话恢复、工具卡和运行状态来自 Harness 原生实现；选中节点和当前项目变化能被工具读取。

### 阶段四：TapCanvas 原生工具注册

1. 在 Harness 原生 Cordis/profile 工具注册图中加入 `tapcanvas_*` 工具，不新增平行工具编排器。
2. 第一批实现只读能力：当前用户、项目、画布、选区、节点和任务状态读取。
3. 工具通过内部 HTTP 接口调用 Hono，Hono 只负责身份、项目权限、schema、边界和确定性业务动作。
4. 将前端生成的 `executionPolicy` 绑定到当前项目和回合快照，默认值为 `autonomous`。
5. 第二批接入节点创建/修改、删除、覆盖、批量修改和计费生成；高风险动作按项目策略自主执行，不从聊天文本推断策略。
6. 对同项目写入增加串行化和节点版本校验；冲突显式返回 `canvas_conflict`，不静默覆盖。
7. 保留真实工具事件、资产 URL、节点状态和失败原因，供现有 trace/diagnostics 与交付验收使用。

**门禁**：Agent 可在当前项目内读取并操作画布；未授权项目请求被拒绝；策略切换只影响后续回合；并发写入不会静默丢失修改；已生成资产不因后处理失败而删除或回滚。

### 阶段五：小T入口硬切换

1. 将小T入口改为打开左侧 Harness 工作区，不再跳转独立 Harness 页面。
2. 移除新入口对 `/public/chat → Hono → Agents Bridge → agents-cli` 的调用。
3. 保留旧链路源码、测试和显式诊断启动命令，但禁止默认启动、自动回退和双份会话展示。
4. 更新 `apps/hono-api/README.md` 的“AI 对话架构（当前）”，准确描述 Harness 直连、工具宿主、会话索引和旧链路保留状态。

**门禁**：同一小T入口只有 Harness 一个 Agent Runtime；旧链路不会被默认拉起；新链路失败时原地暴露真实错误。

### 阶段六：验证、发布与来源移除

1. 运行 Harness 工作区构建、类型检查、连接认证和 Web 测试。
2. 运行 TapCanvas Web、Hono API 与 Agent 集成测试，覆盖身份隔离、会话恢复、流式事件、工具调用、策略冻结、并发冲突和权限失效。
3. 验证开发环境一条命令启动：统一入口、Hono、new-api 及其它必要业务依赖；旧 Agent 只在显式命令下启动。
4. 验证开发和生产环境均由 `apps/agents` 提供单一浏览器入口，后端依赖保持独立部署。
5. 完成迁移验收清单后，单独请求删除 `third-party/deepseek-harness`；确认后再移除来源目录和相关启动引用。

## 不在本计划中的事项

- 不重写 Harness Agent Loop、会话内核、流式协议或子代理实现。
- 不保留第二套新的 TapCanvas Agent 编排链路。
- 不建设业务审计页面、审计报表或独立审计存储。
- 不从聊天文本通过关键词、正则或本地 route 推断执行策略。
- 不在迁移验收前删除旧代码或第三方来源。

## 最终验收标准

- 开发和生产浏览器都只访问 `apps/agents` 提供的统一 Origin；Vite Dev Server 不承担用户访问入口。
- 左侧 Harness 工作区可收起，并与当前画布项目、选区和节点状态联动。
- Harness 原生会话、流式聊天、工具调用和子代理正常工作。
- 会话按用户和项目隔离，重启后可恢复；完整消息只由 Harness JSONL 保存。
- `executionPolicy` 默认自主、由前端选择、只作用于当前项目，并在回合开始时冻结。
- 自主模式可执行项目内高风险工具动作；并发写入冲突显式失败。
- Hono 只执行确定性业务动作，不承担 Agent 语义编排。
- Agents Bridge 与旧 `agents-cli` 源码仍可手动启动，但不被新入口默认调用。
- 所有对话链路、工具回执和交付验收文档与真实代码一致。
