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
