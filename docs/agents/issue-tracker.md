# Issue Tracker：本地 Markdown

本仓库的问题与规格文档统一存放在 `.scratch/`。

## 约定

- 一个功能对应一个目录：`.scratch/<feature-slug>/`
- 功能规格文件：`.scratch/<feature-slug>/spec.md`
- 实现问题按票据拆分：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`
- 票据编号从 `01` 开始，不合并成单一 tickets 文件
- 每个票据顶部附近使用 `Status:` 记录分流状态
- 评论和对话历史追加在文件末尾的 `## Comments` 标题下

## 发布到 issue tracker

创建 `.scratch/<feature-slug>/` 目录，并在其中写入对应文档。
