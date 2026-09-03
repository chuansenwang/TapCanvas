# 采用 Harness 作为 TapCanvas 唯一智能体运行时

TapCanvas 将 DeepSeek Harness 的完整工作区迁入 `apps/agents`，直接在其原生认证、Web Server、会话、Agent Loop、工具注册和子代理目录中整合 TapCanvas 能力；`apps/agents` 成为唯一浏览器入口和智能体运行时。旧 `apps/agents-cli` 与 Agents Bridge 源码在迁移期保留但不再作为新的小T入口，避免维护两套会话和 Agent 执行链。选择该方案是因为 Harness 已经具备所需的会话、流式聊天、工具调用和子代理能力，继续通过桥接层会重复实现运行时并引入跨 Origin 与身份同步问题。

## 后果

- `apps/agents` 保留 Harness 完整根工作区结构和 MIT/第三方版权文件，后续由 TapCanvas 维护，不做自动上游同步。
- `apps/web` 继续拥有画布源码；`apps/agents` 的原生 Web Server 在开发和生产期都直接托管画布构建产物，浏览器只访问一个 Origin。开发期可运行 Vite 构建监听器更新产物，但 Vite Dev Server 不作为浏览器入口。
- Harness JSONL 保存完整工作区会话；TapCanvas 数据库只保存用户、项目、画布与会话的索引映射。
- `tapcanvas_*` 工具在 Harness 原生工具注册图中执行，通过内部接口调用 Hono 的确定性业务能力。
- 第三方来源目录只有在迁移验收通过且得到删除确认后才移除。
