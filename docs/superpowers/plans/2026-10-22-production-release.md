# 2026-10-22 正式发布记录

## 本次改动

将 `main@2c4264a`（含 PR#1、PR#2：批改结果对齐导出，修正识别、建议、方向和失败重跑）发布到正式环境，供老师使用。未删除功能。

- 日期：2026-10-22
- 正式地址：https://ai-composition-grader.mickyzhou7.workers.dev
- 新 Worker 版本：`28b976e6-7200-48ec-bead-c33932915087`（100% 流量）
- 上一版本（回滚用）：`24ab0248-cb8a-494b-9322-2ae238f3e845`
- 源码：已在 GitHub `main`，提交 `2c4264a`，发布前工作区干净

## 构建与发布

- 使用 Node 24.19.0（`npx -y node@24`，项目要求 >=24；默认 PATH 为 Node 22）。
- `npm run build`（Next.js 静态导出到 `dist`），再 `npx wrangler deploy`。
- 首次 `wrangler deploy` 打包失败：本机 `node_modules` 缺少新依赖 `jpeg-js`（未上线、无影响）。执行 `npm install` 后重新构建并发布成功；`package-lock.json` 未改动。
- `dist` 中无开发、服务端构建或缓存目录；线上 `/dev/package.json` 返回 404。

## 数据库

- `wrangler d1 migrations list --remote`：无待应用迁移（最新为 `0008_review_classification.sql`），本次未动数据库。

## 冒烟（未登录）

- `/api/health` 200（`status: ok`），`/login`、`/new`、`/reviews`、`/`、PDF worker 均 200。
- 未登录访问 `/api/classes`、`/api/reviews` 返回 401。
- 未用真实学生作文测试，未修改线上数据；已登录主流程回归未在本次执行。

## 本日第二次发布：PR#3 Word 导出横向 A4 两栏

- 源码：`main@841ec57`（PR#3：Word 导出改为横向 A4 两栏，每段一个浅黄文本框），发布前工作区干净
- 新 Worker 版本：`4a07a198-0222-4cde-adcc-25b04af79753`（100% 流量）
- 上一版本（回滚用）：`28b976e6-7200-48ec-bead-c33932915087`
- Node 24.19.0（`npx -y node@24`），`npm run build` 后 `npx wrangler deploy`，一次成功；依赖无变化，未改 `package-lock.json`
- D1：远程无待应用迁移，未动数据库
- 冒烟（未登录）：`/api/health`、`/login`、`/new`、`/reviews`、`/`、PDF worker 均 200；`/api/classes`、`/api/reviews` 401；`/dev/package.json` 404
- 未用真实学生作文，未改线上数据；Word 导出新版式需登录后人工导出确认，本次未执行

## 本日第三次发布：PR#4 多图不卡读取、批注容错、逐段按完整范文分段

- 源码：`main@f50befa`（PR#4 合并提交 `68c6253` + 发布修复 `f50befa`），发布前工作区干净（`backups/` 未纳入版本库）
- 新 Worker 版本：`44c5d1c2-5920-4801-b7d8-d38e3e6373a9`（100% 流量）
- 上一版本（回滚用）：`4a07a198-0222-4cde-adcc-25b04af79753`
- Node 24.19.0（`npx -y -p node@24`），`npm run build` 后 `npx wrangler deploy`

### 发布修复（f50befa）

- 首次构建失败：`scripts/sync-model-essays.ts` 类型错误，改为写入前用 `evaluationReportSchema` 解析报告。
- 首次 `wrangler deploy` 被拒：免费套餐不支持 `limits.cpu_ms`（code 100328），已从 `wrangler.jsonc` 删除。
- `import:grading-opinions` 新增 `--d1` 只读预览（只执行 SELECT）。
- 逐段一律按完整范文段数分段：新增 `noSourceParagraph`，原文段数不够时对不上原文的段整段按新增划线；「同步到逐段」、新批改和 `sync:model-essays --follow-model-paragraphs` 都按此规则。PDF/Word 导出已加测试。
- `package-lock.json` 与 `package.json` 重新同步（原锁文件缺 esbuild 等，`npm ci` 失败）。
- 测试：`vitest run --no-file-parallelism` 114 个文件、1215 项通过；`next build` 通过。

### 数据库

- 发布前备份：`wrangler d1 export --remote` → Mac `backups/d1-prod-20261022-195624.sql`
- 已应用迁移 `0009_review_rejected`、`0010_grading_opinions`、`0011_grading_opinion_fields`、`0012_grading_opinion_scope`
- 历史作文统一：`sync:model-essays --d1 --apply --follow-model-paragraphs --confirm 上线`，已审核 19 篇，写入 17 篇，2 篇原本一致；备份 `backups/sync-model-essays-backup-20261022-2015.json`（可 `--rollback`）。复跑 dry-run：19 篇全部逐字一致。
- 历史意见：`import:grading-opinions --preview-standing-by-title --d1` 只预览，结果为空（生产 `grading_opinions` 与 `analysis_jobs` 均为 0 行），未写入。

### 冒烟（未登录）

- `/`、`/api/health`（status ok）、`/login`、`/new`、`/reviews`、`/reviews/batch`、`/opinions`、`/settings`、PDF worker 均 200
- `/api/reviews`、`/api/classes`、`/api/grading-opinions` 401；`/dev/package.json` 404
- 已登录主流程与 PDF/Word 实际导出未在本次人工执行

## 发布后数据修复（2026-10-22 20:18–20:36）

### 补回迁移 0009 级联删除的数据

- 根因：0009 用 `PRAGMA foreign_keys = OFF` 重建 `reviews`，D1 不认该 PRAGMA，`DROP TABLE reviews` 触发 `ON DELETE CASCADE`，清空 `review_images`（98 行）、`annotations`（184 行）、`analysis_jobs`（152 行，含 36 条 teacher_guidance）。导出报「第 N 页图片不存在」由 `src/delivery/readiness.ts` 的页图检查触发。与统一作文脚本无关（脚本只 UPDATE reviews）。
- R2 图片对象 128 个逐个核对，全部仍在。
- 修复前备份：`backups/d1-prod-before-restore-20261022-201841.sql`
- 从发布前备份按主键 `INSERT OR IGNORE` 补回三张表共 434 行（`backups/restore-20261022-201841.sql`），未覆盖现有行，报告未变。
- 验证：19 篇已审核作文所需页图齐全；sync dry-run 19 篇逐字一致。
- 防再犯：提交 `f317886`，0009 重建前保存子表、重建后放回；新增 `test/d1-migrations.test.ts`。
- 历史意见预览（`--d1`，只读）：「这件事打动了我」21 条、「为自己鼓掌」2 条，未写入。

### 作文状态统一为待审核（用户要求）

- 备份：`backups/d1-prod-before-status-reset-20261022-203447.sql`
- 19 篇（已导出 9、已复核未导出 10）改为 `ready_for_review`、清空 `teacher_reviewed_at`、修订号 +1、清空 PDF 缓存与导出时间；报告、范文、OCR、图片未动。
- 未改：分析失败 4 篇；原本待审核 23 篇。改后待审核 42 篇、失败 4 篇，均在批量审核队列条件内。
- 执行：`backups/status-reset-20261022-203447.sql`；回滚：`backups/status-reset-rollback-20261022-203447.sql`（逐篇原状态，仅恢复修订号未再变化的行）

## 本日第四次发布：Word 完整范文换行修复

- 源码：`main@573df68`，发布前工作区干净
- 新 Worker 版本：`47975967-2bdf-46e8-b1fd-095385ded6f1`（100% 流量）
- 上一版本（回滚用）：`44c5d1c2-5920-4801-b7d8-d38e3e6373a9`
- 改动：Word 完整范文每个自然段一个段落、首行缩进两字、段内无硬换行，由 Word/WPS 自动排版；右侧框「改后全段」正文去掉换行。PDF 不变。
- Node 24.19.0，`npm run build` 后 `npx wrangler deploy`，一次成功；本次未动数据库
- 冒烟（未登录）：`/`、`/api/health`（status ok）、`/login`、`/new`、`/reviews`、`/reviews/batch`、`/opinions`、`/settings`、PDF worker 均 200；`/api/reviews`、`/api/classes`、`/api/grading-opinions` 401；`/dev/package.json` 404
- 已登录在 WPS 打开实际导出未在本次执行；样例见 Mac 桌面 `样例-范文换行修复.docx`

## 本日第五次发布：批量审核操作栏吸顶

- 源码：`main@4e0aecd`，发布前工作区干净
- 新 Worker 版本：`3c389de0-aac4-4d45-9557-cfd55210514b`（100% 流量）
- 上一版本（回滚用）：`47975967-2bdf-46e8-b1fd-095385ded6f1`
- 改动：批量审核页「不合适」「审核通过并进入下一篇」和保存提示移到三栏上方吸顶，底部不再重复；单篇复核页无底部栏，未改
- Node 24.19.0，`npm run build` 后 `npx wrangler deploy`，一次成功；未动数据库
- 冒烟（未登录）：`/`、`/api/health`（status ok）、`/login`、`/new`、`/reviews`、`/reviews/batch`、`/opinions`、`/settings`、PDF worker 均 200；`/api/reviews`、`/api/classes`、`/api/grading-opinions` 401；`/dev/package.json` 404；线上样式表已含 `batch-review-actionbar`
- 已登录界面（桌面/窄屏）未在本次人工查看

## 本日第六次发布：审核通过时自动同步到逐段

- 源码：`main@013c80d`，发布前工作区干净
- 新 Worker 版本：`0dd827f8-4a79-45e0-80b8-9e40dd2574c5`（100% 流量）
- 上一版本（回滚用）：`3c389de0-aac4-4d45-9557-cfd55210514b`
- 改动：批量与单篇「审核通过」前自动执行「同步到逐段」逻辑，服务端审核通过接口同样同步；已一致不改；按钮与「与逐段不一致」提示保留
- Node 24，`npm run build` 后 `npx wrangler deploy`，一次成功；未动数据库
- 冒烟（未登录）：`/`、`/api/health`（status ok）、`/login`、`/new`、`/reviews`、`/reviews/batch`、`/opinions`、`/settings`、`/pdfjs/pdf.worker.min.mjs` 均 200；`/api/reviews`、`/api/classes`、`/api/grading-opinions` 401；`/dev/package.json` 404
- 已登录审核流程未在本次人工执行
