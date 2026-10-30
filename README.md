# AE 第二大脑 + 技术支持工作台

给机器视觉 AE 工程师用的个人知识库。两部分：

1. **Markdown 知识库**（本目录）：所有资料、每天的工作都有固定位置，任何 AI（Claude Code / Cursor / Codex）打开这个文件夹就能读懂"我是谁、在做什么"。
2. **技术支持工作台**（`workbench/`）：本地网页应用，解决每天最耗时的事——
   - 粘贴微信/飞书聊天记录 → AI 整理成结构化支持记录，**不确定的地方单独标黄让你核对**
   - 聊天原文完整备份在记录里；「我的思考」单独一栏，有快捷提示，几句话就能记下判断
   - 一键复制成飞书表格的行（支持批量），不再手动一条条填
   - 每个客户一条**从头到尾的时间线**，加客户档案和资料附件
   - 所有记录里的痛点自动汇总进**需求池**，按影响客户数排序，一键生成需求分析文档

工作台读写知识库里的 `customers/`、`requirements/`。真实数据不进本仓库，用 `KB_DIR` 指到仓库外的私有目录（见「真实数据放在哪」）。

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
- **飞书直写**：在 `.env.local` 填写 `LARK_BASE_TOKEN` 和 `LARK_TABLE_ID`。`.env.example` 只有占位符，仓库不内置默认表格。
- **飞书测试表探测**：在 `workbench/.env.local` 写上与生产表不同的 `LARK_TEST_TABLE_ID`。Windows：`cd /d C:\Users\TianYun\cognito-ai\workbench && node scripts\lark-t4-probe.mjs`。用户本机（AE智能助手）已跑通，三行 SUMMARY 都是 `PASS`。脚本按那次结果处理：`record_id` 读 `data.record.record_id_list[0]`；创建后等 1.5 秒再更新（否则可能 `800030405 not_found`）；附件 `--file` 用当前目录相对路径；`--json @file.json` 用无 BOM 的 UTF-8（不要用 PowerShell `Set-Content -Encoding UTF8`）。多选写字符串数组，例如 `{"fldWlbihaw":["尺寸测量","外观检测"]}`。人员字段写 open_id 对象 `{"fldR5MJ3au":[{"id":"ou_…"}]}`，不要写显示名字符串。详情在脚本开头。
- ⚠️ 聊天记录会发送给你配置的模型服务商。涉及客户机密时，先确认公司规定，或使用公司内部部署的模型（同样填 `AI_BASE_URL` 即可）。

### 飞书表格列对齐
「复制为飞书行」按 `KB_DIR/config/feishu-table.json` 的列顺序输出。仓库只带虚构示例 `workbench/config/feishu-table.example.json`，没有这份私有配置时会提示路径，不会退回旧的 11 列模板。

1. 没设 `KB_DIR` 时，工作台用仓库根目录，配置文件就是 `config/feishu-table.json`。这个路径已在根目录 `.gitignore` 里，不会被提交。设了 `KB_DIR` 就放到那个目录的 `config/feishu-table.json`。
2. 记一笔页的「从飞书同步字段」用 `lark-cli` 按列名对齐。确认后只把选项和 `fieldId` 写入私有配置。本人 open_id 请手填 `people.defaultOpenId`（`ou_…`），同步不会写入它。
3. 复制示例后再改。列顺序必须与测试表「工作台粘贴」视图从左到右一致。`type`：`text` 文本、`date` 日期、`select` 单选、`multi` 多选、`person` 人员、`attachment` 附件。
4. 示例里的客户公司是虚构的。处理状态、支持类型、解决方式等用的是字段说明里的选项名，不含客户名或同事名。真实客户选项只放在私有 `feishu-table.json`。
5. 多选粘贴分隔符是文件顶部的 `multiSeparator`，默认英文逗号 `,`。测试表如果认顿号或其他符号，只改这一处。
6. 处理人不在粘贴的 20 列里。cli 写入用 `people.fieldId`（同步字段时按列名「处理人」填上）和 `people.defaultOpenId`（本人的 `ou_…`，只能手填在私有配置里）。
7. 默认通道是 `lark-cli`（`LARK_PUSH_MODE=cli`）。cli 按 `fieldId` 建行：文本和单选是字符串，多选是字符串数组，日期是毫秒时间戳，处理人是 `[{id}]`。没有 fieldId 的列会跳过并警告。复制为飞书行只是失败时的兜底。
8. 同一条本地记录对应飞书同一行。建行成功后，frontmatter 写入 `feishu_record_id`、`feishu_synced_at`，并保持 `feishu_synced: true`。记录页或编辑页点「同步飞书」：有行号就用 `lark-cli base +record-upsert --record-id` 改这一行，不会再建一行；没有行号才新建，成功后再把行号写回来。字段写法与建行相同。
9. 再次同步时，附件只追加还没传过的截图（文件名记在 `feishu_attached`），不清空飞书里已有附件。`--file` 用工作目录下的相对路径；文件在仓库外时先复制到 `workbench/.tmp/` 再传。若更新马上返回 `800030405 not_found`，会等 1.5 秒再试一次。
10. `node scripts/lark-t4-probe.mjs` 仍是测试表上的调试脚本，不参与日常保存。日常以工作台「同步飞书」为准。

### 验收
**主验收：cli 把 20 列都写对**
1. 检出本分支，`cd workbench && npm install`。`.env.local` 使用默认 `LARK_PUSH_MODE=cli`，并填写测试表的 `LARK_BASE_TOKEN`、`LARK_TABLE_ID`。`lark-cli` 已用个人身份登录。
2. 把 `workbench/config/feishu-table.example.json` 复制到 `KB_DIR/config/feishu-table.json`（没设 `KB_DIR` 就是仓库根的 `config/feishu-table.json`，已被 gitignore）。
3. `npm run dev`，打开记一笔，点「从飞书同步字段」，核对选项和 fieldId 的差异后再确认写入。在同一文件填 `people.defaultOpenId` 为自己的 `ou_…`。飞书里仍叫「字段1 / 字段2 / 字段3」的列对不上「本地记录ID」「需求线索」：确认哪一列是哪一个之后，在私有配置里给该列加 `feishuName`（例如 `"feishuName": "字段2"`），再同步一次。不要猜，也不要提交这个文件。
4. 保存一条测试记录。到测试表核对这一行：20 列都在对应列上，多选是多个选项，处理人是本人。打开本地 md，frontmatter 里应有 `feishu_record_id`。
5. 改这条记录的处理状态，再点「同步飞书」。飞书里仍是刚才那一行（同一个 record_id），状态已变，没有第二行。提示语会写明「已更新同一飞书行」。再点一次同步，还是这一行。

**次验收：剪贴板兜底**
点「复制为飞书行」。点击当下会把接口 Promise 交给 `ClipboardItem`。粘到「工作台粘贴」视图只作对照。浏览器不支持时，页面给出已全选的文本，按 Ctrl 或 Cmd + C。多选分隔符默认英文逗号，不对就改 `multiSeparator`。

等真机 cli 验收和「通过，可合并」之后再合并。不要 squash，不要自行合入。

新增且可选的 frontmatter 键：`site`、`support_type`、`resolution`、`fixed_version`、`dimensions`、`inspection_types`、`industries`、`case_visibility`、`docs`，自动生成的 `local_id`（`AE-YYYYMMDD-NN`），以及同步成功后的 `feishu_record_id`、`feishu_synced_at`、`feishu_attached`。旧记录没有这些键也能打开。`channel`、`module` 仍留在本地，不导出；`category` 不再出现在表单里，旧值保留。

## 真实数据放在哪

真实客户记录、需求文档和日记放在仓库外的私有目录，不要提交进这个仓库。仓库里只留代码，以及 `customers/示例-*`、`02-projects/_example-project/` 这类虚构示例。

1. 在仓库外建一个私有目录，例如 `~/ae-kb`。
2. 第一次使用时，把本仓库的 `01-me/`、`templates/`、`prompts/` 复制到那个目录。
3. 在 `workbench/.env.local` 里指向它（复制 `workbench/.env.example` 后填写）：

```bash
KB_DIR=/绝对路径/到/私有知识库
```

工作台此后读写该目录下的 `customers/`、`requirements/`。不设 `KB_DIR` 时，默认用 `workbench/` 的上一级目录，也就是本仓库；日常使用请改到仓库外。

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
| 备份 | 代码和示例随本仓库；真实知识库目录单独备份 |
