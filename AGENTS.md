<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# 版本同步规则（所有 Agent 必须遵守：Claude、Codex、Cursor、千问等）

这个项目有三份代码：**本地**、**GitHub**（https://github.com/mickyzhou-glitch/ai-composition-grader ）、**线上**（Cloudflare Worker `ai-composition-grader`，https://ai-composition-grader.mickyzhou7.workers.dev ）。要求是三份永远对得上：

- **GitHub `main` 是唯一标准。** 线上只能跑 `main` 上已经推送的某个提交。
- 本地不能留只有本机才有的东西：不能有没推的提交、长期不动的 stash，也不能有散落的 worktree。

## 1. 开工前先对版本

```bash
git fetch --prune
git status --short                      # 应为空
git rev-list --left-right --count main...origin/main   # 应为 0 0
npx wrangler deployments list | tail -6 # 最后一条 Message 末尾是 main@<提交>
```

只要有一项对不上（工作区不干净、main 和 origin/main 有差异，或者线上的提交不是 main 上的），**先停下来告诉用户**，不要在这种状态下接着改。

## 2. 开发中

- 从最新的 `main` 拉功能分支，或者开 worktree 也可以，名字带上日期。
- 用户还没确认的改动留在功能分支上。**本次会话结束前，必须提交并推到 GitHub 的同名分支**，不能只留在本机，也不要用 stash 存。

## 3. 用户确认后：合并 → 推送 → 发布（按顺序，一次做完）

1. 跑测试：`npm test`、`npm run cf:test`、`npx tsc --noEmit`、`npm run build`。全部通过才能往下走。
2. 合并到 `main`，优先用 fast-forward。然后 `git push origin main`。
3. 核对 `git rev-parse HEAD` 等于 `git rev-parse origin/main`，并且工作区是干净的。**没推到 GitHub 的代码一律不发布。**
4. 如果有新的 `migrations/*.sql`：先把正式 D1 导出备份到 `backups/`，再执行 `npx wrangler d1 migrations apply ai-composition-grader --remote`。
5. 发布时把提交号写进部署说明，方便以后对版本：
   ```bash
   npm run build
   npx wrangler deploy --message "<提交标题> main@$(git rev-parse --short HEAD)"
   ```
6. 冒烟检查：`/login`、`/new`、`/api/health` 应返回 200；未登录访问 `/` 应 302 跳到登录页；未登录访问 `/api/reviews` 应返回 401。另外把本次改的功能点一遍。
7. 写发布记录：`docs/发布记录/YYYY-MM-DD-<标题>.md`，照着已有文件的格式写，要包含 Git 提交、Worker Version ID 和上一版本 ID、测试结果、有没有动数据库、哪些没验证。写完提交并 `git push origin main`。
8. 功能分支合并完就删掉，本地和 GitHub 两边都删。用 worktree 的话，执行 `git worktree remove`。

只改文档（`docs/`、`*.md`）的提交不用重新发布，但同样要推到 GitHub。

## 4. 结束前自查（汇报时附上结果）

```bash
git fetch --prune
git status --short                                  # 空
git stash list                                      # 空
git worktree list                                   # 只有主目录一行
git rev-list --left-right --count main...origin/main  # 0 0
git for-each-ref --format='%(refname:short) %(upstream:track)' refs/heads  # 每个分支都有上游且没有 ahead
npx wrangler deployments list | tail -6             # 线上 main@<提交> 是 main 的祖先，且和 main 之间只差文档
```

汇报里写明这三样：本地 `main` 的提交号、`origin/main` 的提交号、线上 Worker 版本对应的提交号。如果这次改动没有发布上线，要明确写"未上线"并说明原因。

## 5. 禁止

- 不准在工作区有未提交改动时，或者从功能分支、没推送的提交上执行 `wrangler deploy`。
- 不准用 `git push --force` 推 `main`，也不准改写 `main` 的历史。
- **仓库是公开的。** 不准提交 `.dev.vars`、任何密钥、`backups/`（正式库导出，含学生数据）、`.data/`、真实学生作文或照片。推送前检查 `git diff --cached --name-only`。
- 不准用真实学生作文在正式环境上随便测试。
