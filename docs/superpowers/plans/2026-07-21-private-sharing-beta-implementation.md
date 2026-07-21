# AI 作文批改助手私密分享内测版实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 将当前单机单用户应用改造成最多 2 位受邀教师可通过 ngrok HTTPS 私密使用的内测产品，同时保护真实作文、隔离教师数据，并让 AI 批改在浏览器断线后继续运行。

**架构：** Next.js Web 服务继续只监听 `127.0.0.1:3001`，ngrok 作为唯一公网入口；SQLite 新增用户、会话和持久化分析任务；Web 负责鉴权与短请求，独立 Worker 以全局并发 1 处理 AI；作文文件按用户归属存放，并由每日清理任务在首次上传 30 天后永久删除。

**技术栈：** Next.js App Router、TypeScript、SQLite、Drizzle、Zod、Argon2id、Vitest、Playwright、macOS Keychain、launchd、ngrok。

---

## 实施前约束

- 开始编码前重新阅读 `AGENTS.md`，并以仓库内 `node_modules/next/dist/docs/` 为 Next.js 16 的唯一实现依据。身份验证相关实现至少复核 `authentication.md`、`data-security.md`、`cookies.md` 和 `route-groups.md`。
- 当前工作树中的 `src/settings/keychain.ts` 与 `src/settings/keychain.test.ts` 是既有修复，不得丢弃，也不得与后续功能提交混在一起。
- 每个任务严格按“先写失败测试 → 运行并确认失败原因 → 最小实现 → 运行相关测试 → 提交”的顺序完成。
- 所有业务查询必须同时携带 `ownerId`；禁止先按 `reviewId` 查询后在内存判断归属。
- 公网联调必须在本地测试、生产构建、安全用例全部通过后进行，且仅使用脱敏测试图片。

## 目标文件结构

### 新增

- `src/auth/auth-types.ts`
- `src/auth/password.ts`
- `src/auth/auth-repository.ts`
- `src/auth/auth-service.ts`
- `src/auth/request-auth.ts`
- `src/auth/auth.test.ts`
- `src/auth/tenant-isolation.test.ts`
- `src/api/auth-routes.test.ts`
- `src/api/health-route.test.ts`
- `app/api/auth/login/route.ts`
- `app/api/auth/logout/route.ts`
- `app/api/auth/me/route.ts`
- `app/api/auth/change-password/route.ts`
- `app/api/reviews/[id]/analyze/status/route.ts`
- `app/login/page.tsx`
- `app/change-password/page.tsx`
- `app/(protected)/layout.tsx`
- `app/(protected)/settings/layout.tsx`
- `src/jobs/analysis-job-repository.ts`
- `src/jobs/analysis-job-service.ts`
- `src/jobs/analysis-worker.ts`
- `src/jobs/analysis-jobs.test.ts`
- `src/retention/retention-service.ts`
- `src/retention/retention-service.test.ts`
- `app/api/health/route.ts`
- `src/pdf/print-token.ts`
- `src/pdf/print-token.test.ts`
- `src/runtime/logger.ts`
- `src/runtime/logger.test.ts`
- `scripts/accounts.ts`
- `scripts/worker.ts`
- `scripts/retention.ts`
- `scripts/private-beta.ts`
- `scripts/launchd.ts`
- `scripts/launchd.test.ts`
- `scripts/ngrok.ts`
- `docs/private-beta-runbook.md`

### 移动

- `app/page.tsx` → `app/(protected)/page.tsx`
- `app/new/page.tsx` → `app/(protected)/new/page.tsx`
- `app/reviews/[id]/page.tsx` → `app/(protected)/reviews/[id]/page.tsx`
- `app/settings/page.tsx` → `app/(protected)/settings/page.tsx`
- 与上述页面同目录的页面测试一并移动。

### 修改

- `package.json`
- `.env.example`
- `.gitignore`
- `src/db/schema.ts`
- `src/db/init.ts`
- `src/db/client.test.ts`
- `src/db/review-repository.ts`
- `src/db/review-repository.test.ts`
- `src/runtime/application-services.ts`
- `src/services/review-service.ts`
- `src/services/review-service.test.ts`
- `src/storage/review-file-store.ts`
- `src/storage/review-file-store.test.ts`
- `src/domain/contracts.ts`
- `src/domain/contracts.test.ts`
- `app/api/settings/route.ts`
- `app/api/settings/test/route.ts`
- `app/api/reviews/route.ts`
- `app/api/reviews/[id]/route.ts`
- `app/api/reviews/[id]/analyze/route.ts`
- `app/api/reviews/[id]/files/route.ts`
- `app/api/reviews/[id]/images/route.ts`
- `app/api/reviews/[id]/pdf/route.ts`
- `app/components/AppHeader.tsx`
- `app/globals.css`
- `app/(protected)/new/page.tsx`
- `app/(protected)/reviews/[id]/page.tsx`
- `app/(protected)/page.tsx`
- `src/pdf/pdf-service.ts`
- `src/pdf/pdf-service.test.ts`
- `playwright.config.ts`
- `e2e/workbench.spec.ts`
- `README.md`

---

## 任务 0：隔离并完成当前 Keychain 修复

**文件：**

- 修改：`src/settings/keychain.ts`
- 测试：`src/settings/keychain.test.ts`

- [ ] **步骤 1：审阅现有差异，确认修改仅涉及 Keychain 卡死修复**

运行：

```bash
git diff -- src/settings/keychain.ts src/settings/keychain.test.ts
```

预期：差异不包含账号、ngrok 或内测分享功能。

- [ ] **步骤 2：运行 Keychain 定向测试**

运行：

```bash
npm test -- src/settings/keychain.test.ts
```

预期：全部通过；若失败，先修复现有问题，再继续本计划。

- [ ] **步骤 3：单独提交既有修复**

```bash
git add src/settings/keychain.ts src/settings/keychain.test.ts
git commit -m "fix(设置): 避免密钥保存长时间挂起"
```

预期：工作树不再包含这两个文件的未提交差异。

---

## 任务 1：扩展 SQLite 数据模型并提供可重复迁移

**文件：**

- 修改：`package.json`
- 修改：`src/db/schema.ts`
- 修改：`src/db/init.ts`
- 修改：`src/db/client.test.ts`

- [ ] **步骤 1：添加数据库迁移失败测试**

在 `src/db/client.test.ts` 中添加迁移用例，验证：

- 空数据库创建 `users`、`sessions`、`login_attempts`、`security_events`、`analysis_jobs`。
- `reviews` 具有 `owner_id`、`expires_at`、`deleting_at`。
- 旧数据库迁移后创建 `local-admin`，其密码哈希是不可登录哨兵值 `!bootstrap-required`。
- 所有旧作文归属于 `local-admin`。
- 重复执行初始化不会重复账号、破坏数据或改变已设置的密码哈希。
- `analysis_jobs` 对同一作文仅允许一个 `queued`/`running` 的活动任务。

- [ ] **步骤 2：运行测试并确认因缺少新表或字段失败**

```bash
npm test -- src/db/client.test.ts
```

预期：失败信息指向缺少表、列或迁移逻辑，而不是测试环境错误。

- [ ] **步骤 3：定义 Drizzle 表结构和索引**

在 `src/db/schema.ts` 中加入：

- `users`：`id`、规范化唯一 `username`、`passwordHash`、`role`、`mustChangePassword`、`disabledAt`、时间戳。
- `sessions`：`id`、`userId`、唯一 `tokenHash`、`lastSeenAt`、`expiresAt`、`revokedAt`、时间戳。
- `loginAttempts`：规范化用户名、IP 哈希、成功标记、尝试时间。
- `securityEvents`：用户 ID（可空）、事件类型、安全元数据 JSON、创建时间。
- `analysisJobs`：设计稿规定的状态、阶段、租约、次数、安全错误和时间戳。
- `reviews.ownerId` 非空外键，以及 `expiresAt`、`deletingAt`。

用 SQLite 部分唯一索引约束同一 `reviewId` 只有一个 `queued` 或 `running` 任务。

- [ ] **步骤 4：实现事务化、可重复的初始化迁移**

在 `src/db/init.ts` 中：

- 先创建 `local-admin`，再为旧作文补 `owner_id`，最后收紧约束。
- 使用显式事务，任何一步失败均回滚。
- 保留现有数据和索引。
- 不在日志中输出作文内容、密码哈希或会话令牌。

- [ ] **步骤 5：安装密码依赖并运行数据库测试**

```bash
npm install argon2
npm test -- src/db/client.test.ts
```

预期：全部通过。

- [ ] **步骤 6：提交数据库基础**

```bash
git add package.json package-lock.json src/db/schema.ts src/db/init.ts src/db/client.test.ts
git commit -m "feat(账号): 添加内测用户会话与任务数据表"
```

---

## 任务 2：实现密码哈希与认证仓储

**文件：**

- 新增：`src/auth/auth-types.ts`
- 新增：`src/auth/password.ts`
- 新增：`src/auth/auth-repository.ts`
- 新增：`src/auth/auth.test.ts`

- [ ] **步骤 1：先写认证底层测试**

覆盖：

- 用户名去首尾空格并转小写，空用户名拒绝。
- Argon2id 哈希可验证正确密码，错误密码失败，数据库值不含明文。
- 创建用户时用户名唯一；角色只能为 `admin | teacher`。
- 会话仅保存 SHA-256 令牌哈希，原始令牌只返回一次。
- 12 小时闲置过期；使用中的会话按受控频率同时刷新 `lastSeenAt` 和 `expiresAt = now + 12 小时`，避免每个请求写库但保持真正的滑动过期。
- 修改密码、停用账号和撤销全部会话后旧会话立即失效。
- 连续 5 次失败后，同一用户名和同一来源 IP 都锁定 15 分钟。
- 来源 IP 只以 Keychain 中独立限速密钥计算的 HMAC 保存，数据库和日志不保存原始 IP。
- 登录失败查询不存在用户时执行等价密码校验，避免明显时序差异。

- [ ] **步骤 2：运行测试并确认失败**

```bash
npm test -- src/auth/auth.test.ts
```

预期：因认证模块尚不存在而失败。

- [ ] **步骤 3：实现类型、密码和仓储**

关键接口保持显式：

```ts
type UserRole = "admin" | "teacher";

type AuthenticatedUser = {
  id: string;
  username: string;
  role: UserRole;
  mustChangePassword: boolean;
};

interface AuthRepository {
  findUserByNormalizedUsername(username: string): Promise<UserRecord | null>;
  createSession(userId: string, tokenHash: string, expiresAt: Date): Promise<void>;
  findActiveSessionByTokenHash(tokenHash: string, now: Date): Promise<SessionUser | null>;
  revokeAllUserSessions(userId: string): Promise<void>;
  recordLoginAttempt(input: LoginAttemptInput): Promise<void>;
  recordSecurityEvent(input: SecurityEventInput): Promise<void>;
}
```

原始会话令牌使用 `crypto.randomBytes(32).toString("base64url")`；数据库只保存 `sha256` 十六进制摘要。来源 IP 使用独立随机密钥做 HMAC，该密钥由首次本机安装生成并保存到 macOS Keychain；不得复用平台 API Key、ngrok token 或密码哈希。

- [ ] **步骤 4：运行认证测试与类型检查**

```bash
npm test -- src/auth/auth.test.ts
npx tsc --noEmit
```

预期：全部通过。

- [ ] **步骤 5：提交认证底层**

```bash
git add src/auth
git commit -m "feat(认证): 实现密码哈希与安全会话仓储"
```

---

## 任务 3：实现 AuthService 与本机账号 CLI

**文件：**

- 新增：`src/auth/auth-service.ts`
- 修改：`src/auth/auth.test.ts`
- 新增：`scripts/accounts.ts`
- 修改：`package.json`

- [ ] **步骤 1：为业务规则写失败测试**

覆盖：

- 登录失败统一返回 `INVALID_CREDENTIALS`，不暴露用户名是否存在。
- 锁定返回安全的重试时间，不暴露内部计数。
- 首次登录会话带 `mustChangePassword`，除改密、退出和当前用户接口外不能访问业务功能。
- 改密必须验证当前密码；成功后撤销其他会话并签发新会话。
- 停用账号、恢复账号、重置密码、注销全部会话写入安全事件。
- 教师账号数量超过 2 个时 CLI 拒绝创建；管理员账号不计入此上限。

- [ ] **步骤 2：运行测试并确认业务服务缺失**

```bash
npm test -- src/auth/auth.test.ts
```

预期：新增用例失败。

- [ ] **步骤 3：实现 AuthService**

提供 `login`、`authenticateSession`、`changePassword`、`logout`、`createInvitedUser`、`resetPassword`、`disableUser`、`enableUser`、`revokeAllSessions`。所有时间从可注入时钟获取，便于稳定测试。

- [ ] **步骤 4：实现隐藏密码输入的账号 CLI**

`scripts/accounts.ts` 支持：

```text
npm run accounts -- create --username teacher01 --role teacher
npm run accounts -- reset-password --username teacher01
npm run accounts -- disable --username teacher01
npm run accounts -- enable --username teacher01
npm run accounts -- revoke-sessions --username teacher01
npm run accounts -- list
```

密码从 TTY 隐藏输入或由 CLI 生成，禁止接受 `--password` 参数。生成的初始密码只向当前终端显示一次。

- [ ] **步骤 5：运行测试并人工验证参数保护**

```bash
npm test -- src/auth/auth.test.ts
npm run accounts -- create --username teacher01 --role teacher --password insecure
```

预期：测试通过；第二条命令以非零状态退出并提示不支持命令行密码，不回显 `insecure`。

- [ ] **步骤 6：提交认证服务与 CLI**

```bash
git add src/auth/auth-service.ts src/auth/auth.test.ts scripts/accounts.ts package.json
git commit -m "feat(账号): 添加邀请账号与密码管理命令"
```

---

## 任务 4：添加登录、会话 Cookie 和页面保护

**文件：**

- 新增：`src/auth/request-auth.ts`
- 新增：`app/api/auth/login/route.ts`
- 新增：`app/api/auth/logout/route.ts`
- 新增：`app/api/auth/me/route.ts`
- 新增：`app/api/auth/change-password/route.ts`
- 新增：`app/login/page.tsx`
- 新增：`app/change-password/page.tsx`
- 新增：`app/(protected)/layout.tsx`
- 新增：`app/(protected)/settings/layout.tsx`
- 移动：受保护页面及其测试到 `app/(protected)/`
- 新增测试：`src/api/auth-routes.test.ts`
- 修改：`app/components/AppHeader.tsx`
- 修改：`app/globals.css`
- 修改：`src/runtime/application-services.ts`
- 测试：`src/auth/auth.test.ts`

- [ ] **步骤 1：写 Route Handler 和页面访问失败测试**

验证：

- 未登录访问首页跳转 `/login`，未登录 API 返回统一 `401` JSON。
- 经 ngrok HTTPS 登录设置 `__Host-zuowen_session`，属性为 `HttpOnly; Secure; SameSite=Strict; Path=/` 且没有 `Domain`。
- 经精确的 `http://127.0.0.1:3001` 本机入口登录设置仅该主机可见的 `zuowen_local_session`，保持 `HttpOnly; SameSite=Strict; Path=/`；其他 HTTP 来源一律拒绝。
- 退出登录撤销服务端会话并清除 Cookie。
- 首次登录用户只能进入 `/change-password` 和允许的认证 API。
- 教师访问设置页返回 `404` 或跳转首页，设置 API 返回 `403`。
- 停用用户的既有 Cookie 下一次请求立即失效。

- [ ] **步骤 2：运行测试并确认失败**

```bash
npm test -- src/auth/auth.test.ts src/api/auth-routes.test.ts
```

预期：新增路由和页面保护用例失败。

- [ ] **步骤 3：实现请求鉴权帮助函数**

在 `request-auth.ts` 中分别提供：

```ts
requirePageUser(): Promise<AuthenticatedUser>
requireApiUser(request: Request): Promise<AuthenticatedUser>
requireAdminApiUser(request: Request): Promise<AuthenticatedUser>
assertTrustedWriteOrigin(request: Request): void
```

`cookies()` 必须按 Next.js 16 文档异步调用。Cookie 名称和 `Secure` 属性根据经过完整白名单校验的入口来源决定，禁止信任任意转发头。受保护 layout 只做快速页面重定向；每个 Route Handler、Server Action、数据服务仍须独立鉴权。

- [ ] **步骤 4：实现认证路由和页面**

- 登录响应不得返回密码哈希、会话哈希或锁定内部细节。
- 修改 Cookie 仅在 Route Handler 完成。
- 登录页不加载任何业务数据。
- 设置 layout 只允许 `admin`，教师导航中不渲染设置入口。

- [ ] **步骤 5：运行相关测试和生产构建**

```bash
npm test -- src/auth/auth.test.ts src/api/auth-routes.test.ts
npm run build
```

预期：测试和构建均通过。

- [ ] **步骤 6：提交登录与页面保护**

```bash
git add src/auth/request-auth.ts app src/api/auth-routes.test.ts src/runtime/application-services.ts
git commit -m "feat(认证): 添加登录会话与受保护页面"
```

---

## 任务 5：让作文仓储强制执行教师归属

**文件：**

- 修改：`src/db/review-repository.ts`
- 修改：`src/db/review-repository.test.ts`
- 修改：`src/services/review-service.ts`
- 修改：`src/services/review-service.test.ts`
- 新增：`src/auth/tenant-isolation.test.ts`

- [ ] **步骤 1：写跨教师访问失败测试**

创建 `teacher01` 和 `teacher02`，让前者拥有一篇作文，验证后者：

- 列表中看不到该作文。
- 按 ID 读取、更新、删除、保存报告均得到 `NOT_FOUND`。
- 无法用猜测的图片 ID 或任务 ID反推出记录存在。
- 管理员也不能读取教师作文，除非管理员本身就是 `ownerId`。

- [ ] **步骤 2：运行测试并观察现有越权路径**

```bash
npm test -- src/db/review-repository.test.ts src/services/review-service.test.ts src/auth/tenant-isolation.test.ts
```

预期：测试因当前方法只使用 `reviewId` 而失败。

- [ ] **步骤 3：重构仓储接口**

所有面向用户的入口都显式要求 `ownerId`：

```ts
listReviews(ownerId: string): Promise<ReviewSummary[]>
getReview(ownerId: string, reviewId: string): Promise<ReviewDetail | null>
createReview(ownerId: string, input: CreateReviewInput): Promise<ReviewDetail>
updateReview(ownerId: string, reviewId: string, input: UpdateReviewInput): Promise<ReviewDetail>
deleteReview(ownerId: string, reviewId: string): Promise<void>
```

每个 SQL 查询的 `WHERE` 同时包含 `id = reviewId`、`owner_id = ownerId` 和 `deleting_at IS NULL`。更新与删除必须检查受影响行数，零行统一转成 `NOT_FOUND`。

- [ ] **步骤 4：把 ownerId 贯穿 ReviewService**

禁止从请求体读取 `ownerId`。由已认证用户向下传递，并删除任何带默认管理员归属或可选归属的业务接口。

- [ ] **步骤 5：运行仓储、服务和租户测试**

```bash
npm test -- src/db/review-repository.test.ts src/services/review-service.test.ts src/auth/tenant-isolation.test.ts
```

预期：全部通过。

- [ ] **步骤 6：提交归属隔离**

```bash
git add src/db/review-repository.ts src/db/review-repository.test.ts src/services/review-service.ts src/services/review-service.test.ts src/auth/tenant-isolation.test.ts
git commit -m "feat(隔离): 强制作文查询携带教师归属"
```

---

## 任务 6：隔离作文文件、图片读取与 PDF 打印入口

**文件：**

- 修改：`src/storage/review-file-store.ts`
- 修改：`src/storage/review-file-store.test.ts`
- 修改：`src/pdf/pdf-service.ts`
- 修改：`src/pdf/pdf-service.test.ts`
- 新增：`src/pdf/print-token.ts`
- 新增：`src/pdf/print-token.test.ts`
- 修改：`app/print/reviews/[id]/page.tsx`
- 修改：`app/print/reviews/[id]/PrintReview.tsx`
- 修改：`app/print/reviews/[id]/PrintReview.test.tsx`
- 修改：`src/auth/tenant-isolation.test.ts`

- [ ] **步骤 1：为文件归属和路径安全写失败测试**

验证：

- 新文件写入 `.data/users/<ownerId>/reviews/<reviewId>/`。
- `ownerId`、`reviewId`、文件名包含路径穿越、绝对路径或符号链接时拒绝。
- `teacher02` 不能读取 `teacher01` 的原图、AI 副本、裁剪图或 PDF。
- 旧 `.data/reviews/<reviewId>/` 目录在确认数据库归属后原子迁移到管理员目录。
- 迁移重复执行不会覆盖较新的文件或制造第二份作文。

- [ ] **步骤 2：运行测试并确认旧目录模型无法隔离**

```bash
npm test -- src/storage/review-file-store.test.ts src/pdf/pdf-service.test.ts src/pdf/print-token.test.ts src/auth/tenant-isolation.test.ts
```

预期：新增测试失败。

- [ ] **步骤 3：重构 ReviewFileStore**

所有文件方法接收已由数据库验证的 `ownerId` 与 `reviewId`；使用 `path.resolve` 后再次确认结果仍位于该用户目录内，拒绝符号链接，保持原子写入。

- [ ] **步骤 4：保护 PDF 内部打印页**

为 PDF 生成使用一次性、短时效内部打印令牌：

- 服务端创建仅绑定 `ownerId + reviewId + expiresAt` 的签名令牌。
- Playwright 通过额外请求头发送令牌，不把令牌放进 URL、日志或最终 PDF。
- 打印页收到内部令牌后仍按归属查询；普通登录用户直接访问打印 URL 不获得越权内容。
- PDF 下载 API 先完成当前用户归属校验，再读取服务器生成路径。

- [ ] **步骤 5：运行文件与 PDF 测试**

```bash
npm test -- src/storage/review-file-store.test.ts src/pdf/pdf-service.test.ts src/pdf/print-token.test.ts src/auth/tenant-isolation.test.ts
```

预期：全部通过。

- [ ] **步骤 6：提交文件隔离**

```bash
git add src/storage src/pdf app/print/reviews/'[id]' src/auth/tenant-isolation.test.ts
git commit -m "feat(隔离): 按教师存放作文文件并保护PDF"
```

---

## 任务 7：保护全部业务 API 并校验写请求来源

**文件：**

- 修改：`app/api/settings/route.ts`
- 修改：`app/api/settings/test/route.ts`
- 修改：`app/api/reviews/route.ts`
- 修改：`app/api/reviews/[id]/route.ts`
- 修改：`app/api/reviews/[id]/files/route.ts`
- 修改：`app/api/reviews/[id]/images/route.ts`
- 修改：`app/api/reviews/[id]/pdf/route.ts`
- 修改：`src/api/handlers.test.ts`
- 修改：`src/api/handlers.ts`
- 修改：`src/api/files-route.test.ts`
- 修改：`src/api/pdf-route.test.ts`
- 修改：`src/auth/tenant-isolation.test.ts`

- [ ] **步骤 1：建立接口安全矩阵测试**

对每个业务 API 验证：

| 情况 | 预期 |
|---|---|
| 无 Cookie | `401` |
| 失效或停用账号 Cookie | `401` |
| 首次登录未改密 | `403`，仅认证白名单 API 可用 |
| 错误 `Origin` 的写请求 | `403` |
| 同源教师访问自己的资源 | 成功 |
| 教师访问他人资源 | `404` |
| 教师访问设置 API | `403` |
| 管理员访问设置 API | 成功 |

- [ ] **步骤 2：运行 API 测试并确认保护缺口**

```bash
npm test -- src/api/handlers.test.ts src/api/files-route.test.ts src/api/pdf-route.test.ts src/auth/tenant-isolation.test.ts
```

预期：未鉴权、越权或缺少 Origin 校验的用例失败。

- [ ] **步骤 3：统一 Route Handler 顺序**

每个写接口按固定顺序执行：

1. 校验会话。
2. 校验首次改密状态。
3. 校验受信任 `Origin`。
4. 用当前用户 ID 查询资源。
5. 用 Zod 校验输入。
6. 执行业务操作并返回安全错误。

受信任来源从完整环境变量 `APP_ORIGIN` 读取，例如 `https://example.ngrok-free.app`；生产环境缺失或不匹配时拒绝写请求，禁止用 `endsWith` 判断域名。

- [ ] **步骤 4：避免敏感信息进入响应**

统一错误映射不得包含 SQLite 原文、文件绝对路径、上游模型响应、Cookie、API Key 或调用栈。跨租户的存在性统一隐藏为 `404`。

- [ ] **步骤 5：运行接口安全矩阵**

```bash
npm test -- src/api/handlers.test.ts src/api/files-route.test.ts src/api/pdf-route.test.ts src/auth/tenant-isolation.test.ts
```

预期：全部通过。

- [ ] **步骤 6：提交 API 安全改造**

```bash
git add app/api src/api src/auth/tenant-isolation.test.ts
git commit -m "feat(安全): 为业务接口添加会话归属与来源校验"
```

---

## 任务 8：实现 30 天保留期和可恢复执行的永久删除

**文件：**

- 新增：`src/retention/retention-service.ts`
- 新增：`src/retention/retention-service.test.ts`
- 新增：`scripts/retention.ts`
- 修改：`src/db/review-repository.ts`
- 修改：`src/services/review-service.ts`
- 修改：`src/storage/review-file-store.ts`
- 修改：`src/domain/contracts.ts`
- 修改：`src/domain/contracts.test.ts`
- 修改：`package.json`

- [ ] **步骤 1：用可控时钟写保留期失败测试**

覆盖：

- 首次成功上传图片时设置 `expiresAt = uploadedAt + 30 天`。
- 追加图片、编辑、重新分析、导出 PDF 均不延长 `expiresAt`。
- 未上传图片的草稿在创建 24 小时后清理。
- 到期作文先设置 `deletingAt`，随后从普通查询消失。
- 文件删除成功、数据库删除失败时，下次运行可继续收尾。
- 数据库标记成功、文件删除失败时，下次运行可重试文件删除。
- 手动删除复用同一流程，并取消活动分析任务。
- 清理只删除精确的用户/作文目录，绝不递归操作 `.data/`、用户目录或未解析变量。

- [ ] **步骤 2：运行测试并确认失败**

```bash
npm test -- src/retention/retention-service.test.ts src/domain/contracts.test.ts
```

预期：因缺少到期和分阶段删除逻辑而失败。

- [ ] **步骤 3：实现幂等删除状态机**

顺序为：标记 `deletingAt` → 取消活动任务 → 删除精确作文目录 → 事务删除图片、批注、任务和作文行。失败保留 `deletingAt` 和安全错误事件，下次清理继续；正常读写全部过滤 `deletingAt IS NULL`。

- [ ] **步骤 4：添加清理 CLI**

```text
npm run retention -- run
npm run retention -- inspect
```

`inspect` 只显示作文 ID、归属账号和到期时间，不显示作文内容或图片路径。`run` 输出计数和安全错误码。

- [ ] **步骤 5：运行保留期测试**

```bash
npm test -- src/retention/retention-service.test.ts src/domain/contracts.test.ts
```

预期：全部通过。

- [ ] **步骤 6：提交保留与删除机制**

```bash
git add src/retention scripts/retention.ts src/db/review-repository.ts src/services/review-service.ts src/storage/review-file-store.ts src/domain/contracts.ts src/domain/contracts.test.ts package.json
git commit -m "feat(隐私): 添加作文到期与幂等永久删除"
```

---

## 任务 9：实现持久化 AI 分析任务仓储

**文件：**

- 新增：`src/jobs/analysis-job-repository.ts`
- 新增：`src/jobs/analysis-job-service.ts`
- 新增：`src/jobs/analysis-jobs.test.ts`
- 修改：`src/runtime/application-services.ts`

- [ ] **步骤 1：写任务生命周期和并发失败测试**

覆盖：

- 创建任务返回 `queued`，同一作文重复点击返回原活动任务。
- 不同教师任务可排队，但 `claimNext` 同一时刻只领取一个。
- 领取使用 SQLite 事务并原子设置 `running`、租约、尝试次数和阶段。
- 有效租约不会被另一 Worker 领取；过期租约可被重新领取。
- 任务状态只允许合法转换。
- `attempt` 达到上限后进入 `failed`，不会无限重试。
- 已删除或到期作文的任务进入 `canceled`。
- 查询任务必须同时使用 `jobId + ownerId`，他人得到 `NOT_FOUND`。

- [ ] **步骤 2：运行测试并确认模块缺失**

```bash
npm test -- src/jobs/analysis-jobs.test.ts
```

预期：失败。

- [ ] **步骤 3：实现任务仓储和服务**

公开给页面的安全视图：

```ts
type AnalysisJobView = {
  id: string;
  reviewId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  progressStage:
    | "queued"
    | "reading_images"
    | "generating_review"
    | "validating_result"
    | "saving_result";
  message: string | null;
  createdAt: string;
  finishedAt: string | null;
};
```

响应中不包含租约、内部尝试细节、上游响应或数据库错误。

- [ ] **步骤 4：运行任务测试与类型检查**

```bash
npm test -- src/jobs/analysis-jobs.test.ts
npx tsc --noEmit
```

预期：全部通过。

- [ ] **步骤 5：提交持久化任务层**

```bash
git add src/jobs/analysis-job-repository.ts src/jobs/analysis-job-service.ts src/jobs/analysis-jobs.test.ts src/runtime/application-services.ts
git commit -m "feat(任务): 添加持久化AI分析队列"
```

---

## 任务 10：实现独立单并发 Worker

**文件：**

- 新增：`src/jobs/analysis-worker.ts`
- 新增：`scripts/worker.ts`
- 修改：`src/jobs/analysis-jobs.test.ts`
- 修改：`src/services/review-service.ts`
- 修改：`package.json`

- [ ] **步骤 1：为 Worker 恢复和错误分类写失败测试**

注入假的任务仓储、时钟和分析器，验证：

- 全局一次仅调用一篇作文的分析器。
- 阶段按 `reading_images → generating_review → validating_result → saving_result` 推进。
- Worker 定期续租；进程中断模拟后，租约过期任务可恢复。
- 成功保存报告后才标记 `succeeded`。
- 图片不可辨认时作文进入 `needs_better_images`，任务结束且不生成分数。
- 结构修复失败、超时、429、5xx 映射为教师可执行的安全提示。
- 模型适配器内部单次重试后，任务层只按明确上限重试，不形成嵌套无限循环。

- [ ] **步骤 2：运行测试并确认失败**

```bash
npm test -- src/jobs/analysis-jobs.test.ts
```

预期：新增 Worker 用例失败。

- [ ] **步骤 3：抽离现有同步分析流程**

把“读取图片、调用模型、结构修复、校验、保存报告”整理为可由 Worker 调用的服务方法。Web 请求不得再直接持有 180 秒模型调用。

- [ ] **步骤 4：实现 Worker 主循环**

`scripts/worker.ts`：

- 启动时恢复过期租约。
- 每次只领取一项任务。
- 空队列使用短轮询并支持 `SIGTERM` 优雅退出。
- 收到退出信号后停止领取新任务，允许当前步骤安全结束并释放或续租。
- 日志只包含任务 ID、阶段、耗时和安全错误码。

- [ ] **步骤 5：运行 Worker 测试**

```bash
npm test -- src/jobs/analysis-jobs.test.ts src/services/review-service.test.ts
```

预期：全部通过。

- [ ] **步骤 6：提交后台 Worker**

```bash
git add src/jobs src/services/review-service.ts src/services/review-service.test.ts scripts/worker.ts package.json
git commit -m "feat(任务): 使用独立Worker执行AI批改"
```

---

## 任务 11：把分析 API 和复核页面改为异步任务体验

**文件：**

- 修改：`app/api/reviews/[id]/analyze/route.ts`
- 新增：`app/api/reviews/[id]/analyze/status/route.ts`
- 修改：`app/(protected)/reviews/[id]/page.tsx`
- 修改：`app/(protected)/reviews/[id]/page.test.tsx`
- 修改：`src/api/handlers.test.ts`

- [ ] **步骤 1：写异步接口和刷新恢复失败测试**

验证：

- `POST /api/reviews/:id/analyze` 校验归属与图片后在 1 秒内返回 `202` 和任务安全视图。
- 重复点击返回同一活动任务，不重复创建。
- `GET /api/reviews/:id/analyze/status` 只返回当前用户的任务状态。
- 页面每 1.5 秒轮询，完成、失败或取消后停止。
- 刷新页面会从服务端恢复任务状态，不依赖浏览器内存。
- 断网后保留现有阶段并显示可重连提示；恢复后继续轮询。
- 组件卸载时清理定时器，避免重复请求。

- [ ] **步骤 2：运行测试并确认当前同步行为失败**

```bash
npm test -- src/api/handlers.test.ts app/'(protected)'/reviews/'[id]'/page.test.tsx
```

预期：新增异步用例失败。

- [ ] **步骤 3：实现 202 创建任务与状态查询**

POST 只创建任务，不调用模型。状态查询执行 `ownerId + reviewId` 校验，并将内部阶段映射为中文：排队中、读取作文、生成批改、校验结果、保存结果。

- [ ] **步骤 4：实现可恢复的轮询界面**

按钮状态和提示必须可执行：

- 排队中显示“前面可能有其他作文，可离开页面稍后查看”。
- 处理中显示当前阶段。
- 失败显示安全原因和“重新分析”。
- 图片不可辨认显示“请重新拍照”，不显示分数。

- [ ] **步骤 5：运行异步分析测试**

```bash
npm test -- src/api/handlers.test.ts app/'(protected)'/reviews/'[id]'/page.test.tsx src/jobs/analysis-jobs.test.ts
```

预期：全部通过。

- [ ] **步骤 6：提交异步交互**

```bash
git add app/api/reviews/'[id]'/analyze app/'(protected)'/reviews/'[id]' src/api/handlers.test.ts
git commit -m "feat(批改): 支持后台分析进度与断线恢复"
```

---

## 任务 12：加入真实作文隐私确认和到期提示

**文件：**

- 修改：`app/(protected)/new/page.tsx`
- 修改：`app/(protected)/new/page.test.tsx`
- 修改：`app/(protected)/reviews/[id]/page.tsx`
- 修改：`app/(protected)/reviews/[id]/page.test.tsx`
- 修改：`app/(protected)/page.tsx`
- 修改：`app/(protected)/page.test.tsx`
- 修改：`app/api/reviews/[id]/images/route.ts`
- 修改：`src/domain/contracts.ts`
- 修改：`src/domain/contracts.test.ts`
- 修改：`src/api/handlers.test.ts`

- [ ] **步骤 1：写隐私确认与到期显示失败测试**

验证：

- 未勾选确认时不能上传图片，前后端都拒绝。
- 确认文案明确说明上传权限、遮盖无关身份信息、第三方 AI、30 天本机保存和第三方数据边界。
- 服务端记录本次上传确认时间与文案版本，不新增学生姓名、学号、班级或学校字段。
- 首次上传后列表和复核页显示具体到期日期与剩余天数。
- 重新编辑、分析和导出后到期日不变化。
- 删除按钮明确“永久删除且不可恢复”，需要二次确认。

- [ ] **步骤 2：运行测试并确认失败**

```bash
npm test -- app/'(protected)'/new/page.test.tsx app/'(protected)'/reviews/'[id]'/page.test.tsx app/'(protected)'/page.test.tsx src/api/handlers.test.ts src/domain/contracts.test.ts
```

预期：新增隐私和到期用例失败。

- [ ] **步骤 3：实现前后端双重确认**

上传请求包含固定隐私文案版本；服务端仅接受当前版本和布尔确认值，不能只依赖前端复选框。确认元数据只用于审计，不存储额外学生信息。

- [ ] **步骤 4：实现到期和删除体验**

所有日期按 `Asia/Shanghai` 显示，数据库仍保存 UTC。到期不足 3 天时强化提示，但不自动延长。

- [ ] **步骤 5：运行相关测试**

```bash
npm test -- app/'(protected)'/new/page.test.tsx app/'(protected)'/reviews/'[id]'/page.test.tsx app/'(protected)'/page.test.tsx src/api/handlers.test.ts src/domain/contracts.test.ts
```

预期：全部通过。

- [ ] **步骤 6：提交隐私体验**

```bash
git add app/'(protected)' app/api/reviews/'[id]'/images src/api/handlers.test.ts src/domain/contracts.ts src/domain/contracts.test.ts
git commit -m "feat(隐私): 添加真实作文上传确认与到期提示"
```

---

## 任务 13：添加健康检查、launchd 和 ngrok 运维脚本

**文件：**

- 新增：`app/api/health/route.ts`
- 新增：`src/api/health-route.test.ts`
- 新增：`scripts/launchd.ts`
- 新增：`scripts/launchd.test.ts`
- 新增：`scripts/ngrok.ts`
- 新增：`scripts/private-beta.ts`
- 修改：`package.json`
- 修改：`.env.example`
- 修改：`.gitignore`

- [ ] **步骤 1：写配置生成和秘密保护失败测试**

验证：

- 健康检查只返回 `{"ok":true,"data":{"status":"up"}}`，不返回版本、路径、数据库或模型状态。
- 生成 3 个 launchd 服务：Web、Worker、Tunnel，均有固定工作目录和重启策略。
- Web 明确绑定 `127.0.0.1:3001`，不得绑定 `0.0.0.0`。
- ngrok 只转发到 `http://127.0.0.1:3001`，关闭本地 inspection。
- plist、环境文件、日志和命令行中不含 ngrok token、平台 API Key、密码或 Cookie。
- ngrok token 从 macOS Keychain 在进程内读取后传给子进程，不写磁盘。
- Worker 启动时补跑一次到期清理，并在存活期间每 24 小时运行一次；不增加第 4 个常驻服务。

- [ ] **步骤 2：运行测试并确认脚本缺失**

```bash
npm test -- scripts/launchd.test.ts src/api/health-route.test.ts
```

预期：失败。

- [ ] **步骤 3：实现可审阅的 launchd 配置生成器**

生成的服务名：

```text
ai-composition-grader-web
ai-composition-grader-worker
ai-composition-grader-tunnel
```

Web 使用生产构建；Worker 使用独立入口并负责启动时及每日清理；Tunnel 从 Keychain 获取 token。日志写入 `.data/logs/`，并由脚本限制权限和轮转大小。

- [ ] **步骤 4：实现统一本机运维命令**

```text
npm run private-beta -- install
npm run private-beta -- start
npm run private-beta -- stop
npm run private-beta -- restart
npm run private-beta -- status
npm run private-beta -- logs --service web
```

`install` 先验证 Node、生产构建、Keychain 中的模型密钥和 ngrok token，但在最终安全门禁通过前不得启动 Tunnel。

- [ ] **步骤 5：运行脚本测试和静态检查**

```bash
npm test -- scripts/launchd.test.ts src/api/health-route.test.ts
npx tsc --noEmit
```

预期：全部通过。

- [ ] **步骤 6：提交本机运维能力**

```bash
git add app/api/health src/api/health-route.test.ts scripts package.json .env.example .gitignore
git commit -m "feat(运维): 添加本机常驻服务与ngrok脚本"
```

---

## 任务 14：收紧生产安全配置并编写管理员操作手册

**文件：**

- 修改：`next.config.ts`
- 修改：`src/runtime/application-services.ts`
- 新增：`src/runtime/logger.ts`
- 新增：`src/runtime/logger.test.ts`
- 新增：`docs/private-beta-runbook.md`
- 修改：`README.md`

- [ ] **步骤 1：写安全响应头和日志脱敏失败测试**

验证：

- 所有响应包含 `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、合适的 `Content-Security-Policy`。
- HTTPS 生产入口包含 HSTS；本机开发不错误强制 HTTPS。
- 页面包含 `X-Robots-Tag: noindex, nofollow`。
- 错误日志对 `cookie`、`authorization`、`apiKey`、密码、Data URL 和请求体执行删除或掩码。
- 静态资源之外的所有路径均由认证或内部令牌保护。

- [ ] **步骤 2：运行安全测试并确认缺口**

```bash
npm test -- src/auth src/runtime/logger.test.ts src/api
```

预期：新增响应头或日志用例失败。

- [ ] **步骤 3：添加生产安全头与最小日志**

按 Next.js 16 本地文档配置响应头。CSP 使用与 App Router 兼容的 nonce 或哈希方案，只允许应用自身与必要的图片 Data URL，不使用任意脚本域或宽泛的 `unsafe-eval`。日志默认不记录请求体、查询中的敏感值或响应正文。

- [ ] **步骤 4：编写可直接照做的内测手册**

`docs/private-beta-runbook.md` 必须包含：

1. 开启 FileVault、关闭 `.data/` 的云同步和普通 Time Machine 备份。
2. 创建 `local-admin`、`teacher01`、`teacher02` 并安全传递初始密码。
3. 在 Keychain 中配置平台 API Key 和 ngrok token。
4. 获取并填写 ngrok 固定开发域名与 `APP_ORIGIN`。
5. 在 ngrok 控制台关闭 Full Capture，并说明首次提示页和免费额度限制。
6. 构建、安装、启动、检查状态、查看脱敏日志和停止公网分享。
7. 重置密码、停用账号、撤销会话、手动清理到期数据。
8. Mac 需保持开机、联网且不休眠；离线时教师看到的现象。
9. 教师使用说明和真实作文隐私提醒。
10. 更新版本时先停止领取任务、等待当前任务完成，再重启服务。

- [ ] **步骤 5：运行安全测试并扫描秘密模式**

```bash
npm test -- src/auth src/runtime/logger.test.ts src/api
rg -n --hidden --glob '!node_modules/**' --glob '!.git/**' '(sk-[A-Za-z0-9_-]{12,}|authtoken[=:][^[:space:]]+|password[=:][^[:space:]]+)' .
```

预期：测试通过；扫描只命中明确标注的测试假值或文档示例变量名，不出现真实秘密。

- [ ] **步骤 6：提交安全配置和手册**

```bash
git add next.config.ts src/runtime/application-services.ts src/runtime/logger.ts src/runtime/logger.test.ts docs/private-beta-runbook.md README.md
git commit -m "docs(内测): 添加安全配置与管理员操作手册"
```

---

## 任务 15：完成双教师端到端测试与上线门禁

**文件：**

- 修改：`playwright.config.ts`
- 修改：`e2e/workbench.spec.ts`
- 新增：`e2e/private-beta-auth.spec.ts`
- 新增：`e2e/private-beta-isolation.spec.ts`
- 修改：必要的测试夹具

- [ ] **步骤 1：写完整内测流程 E2E**

覆盖：

- 管理员和两位教师登录、首次改密、退出与再次登录。
- `teacher01` 上传三页脱敏作文、确认隐私提示、创建后台分析、刷新后继续查看进度、编辑批注并导出 PDF。
- `teacher02` 在列表、URL、图片、PDF、任务状态 API 上都无法访问 `teacher01` 的资源。
- 教师无法进入设置；管理员可以配置统一模型 API。
- 停用 `teacher01` 后，其现有浏览器会话下一次请求失效。
- 时间推进到第 30 天后作文不可读取，清理后文件和数据库均不存在。
- Worker 在任务中途终止后，重启可恢复并只生成一份结果。

- [ ] **步骤 2：运行 E2E 并确认新增用例先失败**

```bash
npm run test:e2e -- e2e/private-beta-auth.spec.ts e2e/private-beta-isolation.spec.ts
```

预期：在测试夹具和最终串联完成前失败，失败点对应真实缺口。

- [ ] **步骤 3：补齐测试夹具并使 E2E 通过**

测试使用临时 SQLite、临时 `.data` 目录、模拟 OpenAI 兼容服务和固定时钟；不得连接真实模型或读写开发数据库。

- [ ] **步骤 4：执行完整自动化门禁**

```bash
npm test
npm run lint
npx tsc --noEmit
npm run build
npm run test:e2e
```

预期：所有命令零退出，测试无跳过的关键安全用例。

- [ ] **步骤 5：本机生产模式脱敏验收**

```bash
npm run build
npm run private-beta -- install
npm run private-beta -- start --without-tunnel
curl --fail --silent http://127.0.0.1:3001/api/health
npm run private-beta -- status
```

预期：健康检查只返回最小 JSON；Web、Worker 正常且 Worker 已完成启动清理，Tunnel 尚未启动；登录、上传、排队、恢复、PDF 和删除用脱敏作文人工走通。

- [ ] **步骤 6：执行公网安全门禁**

在启动 ngrok 前逐项确认：

- `APP_ORIGIN` 与 ngrok HTTPS 固定域名完全一致。
- 管理员、`teacher01`、`teacher02` 均已设置强密码并完成首次改密策略。
- 账号列表中没有多余教师，教师总数不超过 2。
- 平台 API Key 和 ngrok token 仅存在 Keychain。
- ngrok Full Capture 已关闭，本地 inspection 已禁用。
- `.data/` 权限、FileVault、备份排除和日志轮转符合手册。
- 未登录、跨教师、错误 Origin、教师设置访问、停用会话用例全部通过。

- [ ] **步骤 7：启动 Tunnel 并只用脱敏内容做公网冒烟测试**

```bash
npm run private-beta -- start --only tunnel
npm run private-beta -- status
```

预期：固定 HTTPS 地址可打开登录页；未登录无法读取业务页面、API、图片和 PDF；登录后完成一次脱敏作文流程。不得在本步骤上传真实学生作文。

- [ ] **步骤 8：提交 E2E 与门禁**

```bash
git add playwright.config.ts e2e
git commit -m "test(内测): 覆盖双教师隔离与公网门禁"
```

---

## 完成定义

只有同时满足以下条件，才可以宣布私密分享内测版完成：

- 自动化测试、Lint、TypeScript、生产构建和 E2E 全部通过。
- 两个教师账号与管理员账号均可用，且教师间数据库、图片、任务和 PDF 的跨租户访问均返回 `404`。
- 所有写接口都有会话、首次改密、Origin、归属和 Zod 校验。
- AI 请求完全移出 Web 长请求，Worker 全局并发为 1，浏览器刷新后能恢复进度。
- 首次上传 30 天到期不可延长，自动清理与手动删除均能从中断状态恢复。
- Web 仅监听 `127.0.0.1:3001`，ngrok 是唯一公网入口，秘密只保存在 Keychain。
- 管理员已按手册关闭 ngrok Full Capture、本地 inspection 与 `.data/` 外部备份。
- 公网冒烟测试仅使用脱敏内容，确认安全后才把固定地址与个人账号密码分别发送给 1–2 位教师。
