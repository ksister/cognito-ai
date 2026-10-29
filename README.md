# AE 第二大脑 + 技术支持工作台

给机器视觉 AE 工程师用的个人知识库。两部分：

1. **Markdown 知识库**（本目录）：所有资料、每天的工作都有固定位置，任何 AI（Claude Code / Cursor / Codex）打开这个文件夹就能读懂"我是谁、在做什么"。
2. **技术支持工作台**（`workbench/`）：本地网页应用，解决每天最耗时的事——
   - 粘贴微信/飞书聊天记录 → AI 整理成结构化支持记录，**不确定的地方单独标黄让你核对**
   - 聊天原文完整备份在记录里；「我的思考」单独一栏，有快捷提示，几句话就能记下判断
   - 一键复制成飞书表格的行（支持批量），不再手动一条条填
   - 每个客户一条**从头到尾的时间线**，加客户档案和资料附件
   - 所有记录里的痛点自动汇总进**需求池**，按影响客户数排序，一键生成需求分析文档

工作台读写的就是本目录下的 Markdown 文件（`customers/`、`requirements/`），用 Obsidian 或 AI 也能直接看、直接改。

## 运行工作台
需要 Node.js 20+。

```bash
cd workbench
npm install
cp .env.example .env.local   # 可选：填 AI_API_KEY 启用大模型
npm run dev                   # 打开 http://localhost:4317
```

- **不配置 AI 也能用**：会用规则做初步提取（区分我方/客户、抓问题和结论、识别"能不能/太麻烦"等需求线索）。
- **配置 AI**：支持任何 OpenAI 兼容接口，`.env.example` 里有 DeepSeek、通义千问、OpenAI 的写法。
- ⚠️ 聊天记录会发送给你配置的模型服务商。涉及客户机密时，先确认公司规定，或使用公司内部部署的模型（同样填 `AI_BASE_URL` 即可）。

### 飞书表格列对齐
「复制为飞书行」按以下列顺序输出（Tab 分隔，粘贴到表格即可自动分列）：
日期、客户、联系人、渠道、产品/版本、模块、问题分类、问题描述、解决方案、状态、需求线索。
如果你的飞书表格列不同，修改 `workbench/src/lib/feishu.ts` 里的 `FEISHU_COLUMNS`。

## 目录结构
```
AGENTS.md / CLAUDE.md   AI 入口说明（AI 每次先读）
00-inbox/               原始输入，先扔进来再说
01-me/                  关于我：profile / goals / style
02-projects/            项目（有目标、有截止）
03-areas/               长期领域
04-resources/           参考资料、方法论
05-archive/             归档
customers/<客户>/        profile.md、records/*.md、files/
requirements/           需求分析文档
journal/                每日日志 YYYY-MM-DD.md
templates/  prompts/    模板与 AI 工作流
scripts/today.sh        命令行快速记一笔
workbench/              技术支持工作台（Next.js）
```

`customers/示例-*` 是演示数据，体验完直接删除这两个文件夹即可。

## 推荐的日常节奏
| 时机 | 做什么 |
|---|---|
| 每次支持后 | 工作台「记一笔」：粘贴聊天 → AI 整理 → 核对黄色提示 → 写两句思考 → 保存 |
| 下班前 | 工作台首页「复制 N 行」粘贴进飞书表格 → 标记为已同步 |
| 每两周 | 「需求池」→ 生成需求分析 → 修改后提交研发 |
| 高频问题 | 让 AI 基于相关记录起草语雀知识库文档 |

## 其他工具
| 用途 | 工具 |
|---|---|
| 浏览/编辑知识库 | Obsidian（把本目录作为 vault 打开） |
| AI 助手 | Claude Code、Cursor、Codex CLI |
| 备份 | git 私有仓库 |
