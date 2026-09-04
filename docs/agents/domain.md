# 领域文档

## 探索前必须读取

- 根目录 `CONTEXT.md`
- `docs/adr/` 中与当前主题相关的 ADR
- 若未来存在 `CONTEXT-MAP.md`，按其指向读取相关上下文

## 当前布局

本仓库采用 single-context：

- `CONTEXT.md`：全局领域词汇与上下文
- `docs/adr/`：架构决策记录
- `docs/agents/`：工程技能所需的 tracker、分流和领域消费规则

## 术语规则

问题标题、重构建议和测试名称应使用 `CONTEXT.md` 中定义的领域术语。若缺少所需术语，应记录为领域建模缺口，不自行引入同义词。
