# AGENTS.md — 给 AI 的入口说明

> 任何 AI（Claude Code / Cursor / Codex / ChatGPT 等）开始工作前，先读这个文件，再读 `01-me/` 下的文件。

## 你在哪里
这是我的个人工作知识库（"第二大脑"）。全部是纯 Markdown 文件，按 PARA 方法组织：

| 目录 | 放什么 |
|---|---|
| `00-inbox/` | 未整理的原始输入：随手记、聊天截取、会议转写、网页摘录 |
| `01-me/` | 关于我：身份、目标、工作方式、偏好、写作风格。**每次任务都要参考** |
| `02-projects/` | 有明确目标和截止时间的项目，每个项目一个文件夹 |
| `03-areas/` | 长期负责的领域（无截止时间），如"团队管理""健康" |
| `04-resources/` | 参考资料、方法论、行业知识、可复用的提示词 |
| `05-archive/` | 已完成或暂停的内容 |
| `journal/` | 每日工作日志 `YYYY-MM-DD.md`，只追加不修改 |
| `customers/<客户>/` | 客户档案 `profile.md`、技术支持记录 `records/*.md`、资料 `files/` |
| `requirements/` | 需求分析文档 |
| `workbench/` | 本地网页工作台（Next.js），读写 `customers/` 和 `requirements/` |
| `templates/` | 各类笔记模板 |
| `prompts/` | 常用 AI 工作流提示词 |

## 工作规则
1. **先查后答**：回答问题前，先在本库里搜索相关内容（`rg` / 全文搜索），引用时给出文件路径。
2. **不要编造关于我的信息**。不确定就问，或写在回答末尾的"待确认"里。
3. **写入规则**：
   - 新的原始信息 → `00-inbox/`，文件名 `YYYY-MM-DD-主题.md`
   - 项目进展 → 追加到对应 `02-projects/<项目>/log.md`，不要改写历史记录
   - 重要决定 → 用 `templates/decision.md` 记录到项目目录下
   - 发现关于我的新偏好/事实 → 提议修改 `01-me/` 的哪一行，**等我确认后再改**
4. **保持格式**：Markdown，中文为主，日期用 `YYYY-MM-DD`，文件开头带 frontmatter（见模板）。
5. **输出风格**：参考 `01-me/style.md`。默认：结论先行、简洁、给可执行的下一步。
6. 不要删除任何文件；需要清理时移动到 `05-archive/`。

## 技术支持记录格式
`customers/<客户>/records/YYYY-MM-DD-<标题>.md`：
- frontmatter：`title date customer channel contact product module category status feishu_synced needs created updated`
  - `status` ∈ 待处理 / 跟进中 / 已解决 / 已关闭
  - `needs` 是 `{pain, idea, type}` 列表，type ∈ 软件改进 / 辅助工具 / 文档/教程 / 其他
- 正文小节固定为：`## 问题描述` `## 处理过程` `## 解决方案` `## 我的思考` `## 待确认` `## 原始聊天记录`（最后一节用四个反引号包裹原文）
- 「我的思考」和「原始聊天记录」由我本人维护，AI 不得改写。

## 常用工作流
见 `prompts/`：
- `ingest.md` — 把 inbox 里的原始材料整理归档
- `daily.md` — 根据今日日志生成总结和明日计划
- `weekly-review.md` — 每周回顾
- `ask-my-brain.md` — 基于我的资料回答问题
- `requirement-analysis.md` — 从全部支持记录中提炼需求
