# 我的第二大脑（AI 协作版）

一个用纯 Markdown 管理的个人工作知识库，目标两个：

1. **持续积累**：所有资料、每天的工作都有固定的地方放，不丢失、可检索。
2. **让 AI 丝滑协作**：AI（Claude Code / Cursor / Codex 等）打开这个文件夹就能读懂"我是谁、在做什么、怎么做事"，直接帮我整理、总结、起草、复盘。

## 为什么是"一个 Markdown 文件夹"
- **File over app**：纯文本永远能打开，不被任何软件绑定；任何 AI 都能直接读写。
- 用 **Obsidian** 打开它当"工作台"（好看、双链、手机同步）；用 **Claude Code / Cursor** 打开它当"AI 助手"。两者操作的是同一批文件。
- 用 **git** 做版本管理和备份，AI 改错了随时能回滚。

## 目录结构（PARA）
```
AGENTS.md / CLAUDE.md   AI 入口说明（AI 每次先读）
00-inbox/               原始输入，先扔进来再说
01-me/                  关于我：profile / goals / style（最重要，先填）
02-projects/            项目（有目标、有截止）
03-areas/               长期领域
04-resources/           参考资料、方法论
05-archive/             归档
journal/                每日日志 YYYY-MM-DD.md
templates/              笔记模板
prompts/                常用 AI 工作流
scripts/today.sh        快速记一笔
```

## 开始使用
1. 填写 `01-me/profile.md`、`goals.md`、`style.md`（30 分钟，回报最高的一步）。
2. 把现有资料（文档、导出的笔记、聊天记录）一股脑放进 `00-inbox/`。
3. 用 Claude Code 或 Cursor 打开本目录，说："按 `prompts/ingest.md` 整理 inbox"。
4. 每天：
   ```bash
   ./scripts/today.sh                    # 创建今日日志
   ./scripts/today.sh "完成了 XX 方案初稿"  # 随手追加一条记录
   ```
   下班前让 AI 执行 `prompts/daily.md`。
5. 每周五：让 AI 执行 `prompts/weekly-review.md`。

## 推荐工具组合
| 用途 | 工具 |
|---|---|
| 工作台 / 阅读编辑 | Obsidian（打开本文件夹作为 vault） |
| AI 助手 | Claude Code、Cursor、Codex CLI |
| 快速采集 | 手机 Obsidian、微信"文件传输助手"→ 定期粘到 inbox、Readwise / 简悦剪藏 |
| 会议转写 | 飞书妙记 / 通义听悟 / 腾讯会议转写，导出后放 inbox |
| 备份同步 | git（私有仓库）+ Obsidian Git 插件 |

> ⚠️ 隐私：这里会有大量个人和公司信息。仓库务必设为私有；涉及公司机密的内容，先确认公司对外部 AI 工具的使用规定。
