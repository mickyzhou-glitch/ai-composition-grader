# Cloudflare 云端基础与账号密码登录实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在不改变教师“用户名 + 密码”使用方式的前提下，为项目建立 Cloudflare Workers 运行基础、浏览器端 Argon2id 挑战登录和可验证的本地开发环境。

**架构：** Worker Static Assets 提供同源静态页面及 `/api/*` 接口；身份协议由一次性挑战、浏览器端 Argon2id 和 Worker 端加密验证材料组成。领域认证逻辑改为异步端口，当前 SQLite 适配器继续支撑本机测试，D1 适配器在下一计划落地。

**技术栈：** Cloudflare Workers、Wrangler、Static Assets、D1（本地模拟）、Web Crypto、Argon2id WASM、Vitest、Playwright、React 19。

---

## 文件结构

- 创建：`wrangler.jsonc` — Worker、静态资源、D1、R2、Queue 和 Secret 名称声明。
- 创建：`worker/index.ts` — Worker fetch 与 Queue 入口；本计划只实现健康检查和认证路由桥接。
- 创建：`src/cloudflare/env.ts` — 经运行时校验的 Worker Binding 类型。
- 创建：`src/auth/password-proof.ts` — 与运行时无关的挑战、证明和加密验证材料类型。
- 创建：`src/auth/password-proof-browser.ts` — 浏览器端 Argon2id 与 HMAC 挑战证明。
- 创建：`src/auth/password-proof-worker.ts` — Worker 端 AES-GCM 加密、解密与恒定时间证明校验。
- 创建：`src/auth/login-challenge-repository.ts` — 一次性登录挑战端口。
- 创建：`src/auth/login-challenge-service.ts` — 挑战生成、消费和认证编排。
- 创建：`src/auth/login-challenge-service.test.ts` — 挑战过期、重放和不可区分失败测试。
- 创建：`src/auth/password-proof-worker.test.ts` — 加密与验证测试。
- 创建：`src/cloudflare/worker-auth-routes.ts` — Fetch API 认证端点。
- 创建：`src/cloudflare/worker-auth-routes.test.ts` — Cookie、来源和错误响应测试。
- 修改：`src/db/schema.ts` — 加入密码验证材料与登录挑战表，不删除旧 `passwordHash`。
- 修改：`src/db/init.ts` — 增量建表与索引 SQL。
- 修改：`src/auth/auth-types.ts` — 增加云端验证材料和挑战记录类型。
- 修改：`src/auth/auth-repository.ts` — 为验证材料和异步挑战提供受控持久化端口。
- 修改：`src/auth/auth-service.ts` — 将会话签发、锁定和密码修改复用到挑战登录流程。
- 修改：`app/login/page.tsx` — 在提交密码前生成证明；不将明文密码发送给 API。
- 修改：`app/login/page.test.tsx` — 覆盖挑战获取、证明提交及用户可见错误。
- 修改：`package.json`、`package-lock.json` — 加入 Wrangler、Cloudflare 测试支持与浏览器 Argon2id 依赖。
- 修改：`.gitignore` — 忽略 `.dev.vars*`、`.wrangler/`、迁移导出和本地 Cloudflare 状态。
- 创建：`.dev.vars.example` — 只列出必需密钥名称，绝不包含真实值。

## 任务 1：建立可验证的 Cloudflare 运行配置

**文件：**
- 创建：`wrangler.jsonc`
- 创建：`src/cloudflare/env.ts`
- 测试：`src/cloudflare/env.test.ts`
- 修改：`package.json`
- 修改：`.gitignore`

- [ ] **步骤 1：编写失败的 Binding 校验测试**

```ts
import { describe, expect, it } from "vitest";
import { readWorkerEnv } from "./env";

describe("readWorkerEnv", () => {
  it("rejects a deployment without its login encryption secret", () => {
    expect(() => readWorkerEnv({ APP_ORIGIN: "https://app.workers.dev" } as never))
      .toThrow("AUTH_PROOF_ENCRYPTION_KEY is required");
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/cloudflare/env.test.ts`

预期：FAIL，报错 `Failed to resolve import "./env"`。

- [ ] **步骤 3：安装运行依赖并加入脚本**

```bash
npm install @cloudflare/workers-types wrangler
npm install @noble/hashes
npm pkg set scripts.cf:dev='wrangler dev' scripts.cf:test='vitest run src/cloudflare' scripts.cf:deploy='wrangler deploy'
```

`wrangler.jsonc` 必须声明 `main`、`assets.directory`、D1/R2/Queue Binding 名称和 `nodejs_compat`；不得写入账户 ID、数据库 ID、Bucket 名称中的个人数据或任何 Secret。

- [ ] **步骤 4：实现最小 Binding 校验**

```ts
export interface WorkerEnv {
  ASSETS: Fetcher;
  DB: D1Database;
  FILES: R2Bucket;
  ANALYSIS_QUEUE: Queue;
  ANALYSIS_DLQ: Queue;
  AUTH_PROOF_ENCRYPTION_KEY: string;
  AUTH_IP_HMAC_SECRET: string;
  AI_API_KEY: string;
}

export function readWorkerEnv(env: WorkerEnv): WorkerEnv {
  if (!env.AUTH_PROOF_ENCRYPTION_KEY) throw new Error("AUTH_PROOF_ENCRYPTION_KEY is required");
  if (!env.AUTH_IP_HMAC_SECRET) throw new Error("AUTH_IP_HMAC_SECRET is required");
  if (!env.AI_API_KEY) throw new Error("AI_API_KEY is required");
  return env;
}
```

- [ ] **步骤 5：运行验证**

运行：`npx vitest run src/cloudflare/env.test.ts && npx wrangler types`

预期：测试通过；Wrangler 生成或更新绑定类型，且未产生 Secret 文件。

- [ ] **步骤 6：提交**

```bash
git add package.json package-lock.json wrangler.jsonc src/cloudflare/env.ts src/cloudflare/env.test.ts .gitignore .dev.vars.example worker/index.ts
git commit -m "feat(cloudflare): add worker runtime foundation"
```

## 任务 2：定义浏览器密码证明与 Worker 加密验证材料

**文件：**
- 创建：`src/auth/password-proof.ts`
- 创建：`src/auth/password-proof-browser.ts`
- 创建：`src/auth/password-proof-worker.ts`
- 测试：`src/auth/password-proof-worker.test.ts`

- [ ] **步骤 1：编写失败的加密与重放隔离测试**

```ts
it("accepts only the proof bound to the issued nonce", async () => {
  const verifier = new Uint8Array(32).fill(7);
  const sealed = await sealPasswordVerifier(verifier, encryptionKey);
  const proof = await createLoginProof(verifier, "login-1", nonceA);

  await expect(verifyLoginProof({ sealed, username: "teacher-1", challengeId: "login-1", nonce: nonceA, proof, encryptionKey })).resolves.toBe(true);
  await expect(verifyLoginProof({ sealed, username: "teacher-1", challengeId: "login-1", nonce: nonceB, proof, encryptionKey })).resolves.toBe(false);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/auth/password-proof-worker.test.ts`

预期：FAIL，报错 `sealPasswordVerifier is not defined`。

- [ ] **步骤 3：实现协议类型和最小密码证明函数**

```ts
export type LoginChallenge = { id: string; username: string; salt: string; nonce: string; expiresAt: number };
export type SealedPasswordVerifier = { ciphertext: string; iv: string; version: 1 };

export async function createLoginProof(verifier: Uint8Array, challengeId: string, nonce: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", verifier, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const data = new TextEncoder().encode(`${challengeId}.${nonce}`);
  return toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, data)));
}
```

浏览器模块必须将密码传入 Argon2id WASM，仅返回派生验证材料；Worker 模块必须使用 `crypto.subtle` 的 AES-GCM 加密验证材料，并在比较证明时使用无早退的字节比较。任何函数不得记录输入值。

- [ ] **步骤 4：运行通过测试与完整认证测试**

运行：`npx vitest run src/auth/password-proof-worker.test.ts src/auth/auth.test.ts`

预期：所有指定测试通过。

- [ ] **步骤 5：提交**

```bash
git add src/auth/password-proof.ts src/auth/password-proof-browser.ts src/auth/password-proof-worker.ts src/auth/password-proof-worker.test.ts
git commit -m "feat(auth): add browser password proof protocol"
```

## 任务 3：持久化一次性挑战和云端验证材料

**文件：**
- 修改：`src/db/schema.ts`
- 修改：`src/db/init.ts`
- 修改：`src/auth/auth-types.ts`
- 创建：`src/auth/login-challenge-repository.ts`
- 创建：`src/auth/login-challenge-service.ts`
- 测试：`src/auth/login-challenge-service.test.ts`

- [ ] **步骤 1：编写失败的挑战生命周期测试**

```ts
it("consumes a challenge once and never exposes whether the username exists", async () => {
  const unknown = await service.issue("not-a-teacher", ipHash);
  const known = await service.issue("teacher-1", ipHash);
  expect(unknown.salt).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(known.salt).toMatch(/^[A-Za-z0-9_-]+$/);

  await expect(service.consume(known.id, validProof)).resolves.toMatchObject({ outcome: "authenticated" });
  await expect(service.consume(known.id, validProof)).resolves.toMatchObject({ outcome: "invalid" });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/auth/login-challenge-service.test.ts`

预期：FAIL，报错模块不存在。

- [ ] **步骤 3：增加数据库对象**

在 `users` 表增加 nullable `password_proof_salt` 与 `password_proof_sealed` 列；创建 `login_challenges` 表：

```sql
CREATE TABLE IF NOT EXISTS login_challenges (
  id TEXT PRIMARY KEY NOT NULL,
  normalized_username TEXT NOT NULL,
  nonce TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS login_challenges_expiry_idx ON login_challenges(expires_at);
```

持久化服务必须只接受已校验的 Base64URL 字段；`consume` 使用单条条件更新 `consumed_at IS NULL AND expires_at > now` 确保原子消费。

- [ ] **步骤 4：实现挑战服务**

```ts
export class LoginChallengeService {
  async issue(username: string, ipHash: string): Promise<LoginChallenge> {
    const normalized = normalizeUsernameOrDummy(username);
    return this.repository.create({ normalizedUsername: normalized, ipHash, ttlMs: 5 * 60_000 });
  }

  async consume(input: ConsumeChallengeInput): Promise<ChallengeLoginResult> {
    const challenge = await this.repository.consumeIfActive(input.challengeId, input.ipHash);
    if (!challenge) return { outcome: "invalid" };
    return this.verifyAndIssueSession(challenge, input.proof);
  }
}
```

调用现有 `AuthService` 的速率限制、会话创建和安全审计逻辑；未知用户始终执行伪验证，外部响应不泄露用户存在状态。

- [ ] **步骤 5：运行通过测试和回归套件**

运行：`npx vitest run src/auth/login-challenge-service.test.ts src/auth/auth.test.ts src/auth/tenant-isolation.test.ts`

预期：所有测试通过。

- [ ] **步骤 6：提交**

```bash
git add src/db/schema.ts src/db/init.ts src/auth/auth-types.ts src/auth/login-challenge-repository.ts src/auth/login-challenge-service.ts src/auth/login-challenge-service.test.ts
git commit -m "feat(auth): persist one-time login challenges"
```

## 任务 4：实现 Worker 认证接口并保留安全 Cookie 行为

**文件：**
- 创建：`src/cloudflare/worker-auth-routes.ts`
- 测试：`src/cloudflare/worker-auth-routes.test.ts`
- 修改：`worker/index.ts`
- 修改：`src/auth/request-auth.ts`

- [ ] **步骤 1：编写失败的 HTTP 契约测试**

```ts
it("sets a __Host- session only after a valid proof", async () => {
  const response = await handleWorkerAuth(
    new Request("https://grader.workers.dev/api/auth/login/complete", { method: "POST", headers: { origin: "https://grader.workers.dev" }, body: JSON.stringify(validRequest) }),
    env,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toContain("__Host-zuowen_session=");
  expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  expect(response.headers.get("set-cookie")).toContain("SameSite=Strict");
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/cloudflare/worker-auth-routes.test.ts`

预期：FAIL，报错 `handleWorkerAuth` 未导出。

- [ ] **步骤 3：实现 `/api/auth/login/challenge` 与 `/api/auth/login/complete`**

```ts
if (request.method === "POST" && pathname === "/api/auth/login/challenge") {
  assertSameOrigin(request, origin);
  return json(await services.loginChallenges.issue(await readUsername(request), sourceIpHash(request, env)));
}
if (request.method === "POST" && pathname === "/api/auth/login/complete") {
  assertSameOrigin(request, origin);
  const result = await services.loginChallenges.consume(await readProofRequest(request));
  return result.outcome === "authenticated" ? sessionResponse(result) : invalidCredentialsResponse();
}
```

路由必须拒绝异常 JSON、跨源写入和缺失 IP；响应不得包含验证材料、nonce、密码、密钥或上游异常。

- [ ] **步骤 4：接入 Worker 入口**

```ts
export default {
  async fetch(request, env, ctx) {
    const configured = readWorkerEnv(env);
    const api = await handleWorkerAuth(request, configured, ctx);
    if (api) return api;
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<WorkerEnv>;
```

保留 `/api/health` 的无鉴权响应；未匹配 API 路由不得意外回退为含敏感信息的静态页面。

- [ ] **步骤 5：运行 Worker 本地测试**

运行：`npx vitest run src/cloudflare/worker-auth-routes.test.ts && npm run cf:dev -- --test-scheduled`

预期：HTTP 契约测试通过；本地 Worker 能返回健康检查且不需要真实 Secret。

- [ ] **步骤 6：提交**

```bash
git add worker/index.ts src/cloudflare/worker-auth-routes.ts src/cloudflare/worker-auth-routes.test.ts src/auth/request-auth.ts
git commit -m "feat(cloudflare): expose password-proof auth routes"
```

## 任务 5：将登录页面改为证明协议

**文件：**
- 修改：`app/login/page.tsx`
- 修改：`app/login/page.test.tsx`
- 修改：`app/lib/api.ts`

- [ ] **步骤 1：编写失败的交互测试**

```tsx
it("requests a challenge and never sends the plaintext password", async () => {
  render(<LoginPage />);
  await userEvent.type(screen.getByLabelText("用户名"), "teacher-1");
  await userEvent.type(screen.getByLabelText("密码"), "correct horse battery staple");
  await userEvent.click(screen.getByRole("button", { name: "登录" }));

  expect(fetch).toHaveBeenNthCalledWith(1, "/api/auth/login/challenge", expect.anything());
  const completion = JSON.parse((fetch as Mock).mock.calls[1][1].body);
  expect(completion).not.toHaveProperty("password");
  expect(completion).toHaveProperty("proof");
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run app/login/page.test.tsx`

预期：FAIL，现有实现向 `/api/auth/login` 发送 `password`。

- [ ] **步骤 3：实现两步登录 UI**

```ts
const challenge = await apiFetch<LoginChallenge>("/api/auth/login/challenge", { method: "POST", body: JSON.stringify({ username }) });
const verifier = await derivePasswordVerifier(password, challenge.salt);
const proof = await createLoginProof(verifier, challenge.id, challenge.nonce);
const user = await apiFetch<User>("/api/auth/login/complete", { method: "POST", body: JSON.stringify({ challengeId: challenge.id, proof }) });
```

在 `finally` 中清除 `password` 状态与派生 `Uint8Array` 引用；Argon2 WASM 加载失败时显示“当前浏览器无法安全登录”，不回退为发送明文密码。

- [ ] **步骤 4：运行页面与全量认证回归测试**

运行：`npx vitest run app/login/page.test.tsx src/auth --passWithNoTests`

预期：登录页面及认证目录测试通过。

- [ ] **步骤 5：提交**

```bash
git add app/login/page.tsx app/login/page.test.tsx app/lib/api.ts
git commit -m "feat(auth): login with browser password proof"
```

## 任务 6：创建本机密码验证材料迁移命令

**文件：**
- 创建：`scripts/migrate-password-proofs.mts`
- 创建：`scripts/migrate-password-proofs.test.ts`
- 修改：`package.json`
- 修改：`README.md`

- [ ] **步骤 1：编写失败的非交互安全测试**

```ts
it("refuses password migration without an interactive terminal", async () => {
  await expect(runPasswordProofMigration({ stdinIsTTY: false, stdoutIsTTY: false }))
    .rejects.toThrow("Password input requires an interactive terminal");
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run scripts/migrate-password-proofs.test.ts`

预期：FAIL，迁移模块不存在。

- [ ] **步骤 3：实现最小安全迁移命令**

```ts
for (const user of selectedUsers) {
  const password = await readHiddenPassword();
  if (!(await verifyPassword(user.passwordHash, password))) throw new Error(`Password verification failed for ${user.username}`);
  const material = await derivePasswordVerifier(password, randomSalt());
  await output.write({ userId: user.id, salt, sealedVerifier: await sealForCloud(material, publicMigrationKey) });
  password.fill?.(0);
}
```

命令必须拒绝 `--password` 参数、不写明文或验证材料到 stdout、在失败时不修改本地数据库。输出只允许为受权限保护的加密迁移包；包路径必须由显式 `--output` 指定且已被 `.gitignore` 排除。

- [ ] **步骤 4：运行迁移命令测试**

运行：`npx vitest run scripts/migrate-password-proofs.test.ts && npm run accounts -- list`

预期：迁移安全测试通过；账号列表命令仍只输出非敏感字段。

- [ ] **步骤 5：提交**

```bash
git add scripts/migrate-password-proofs.mts scripts/migrate-password-proofs.test.ts package.json README.md .gitignore
git commit -m "feat(migration): add interactive password-proof exporter"
```

## 任务 7：基础阶段验证与交付检查

**文件：**
- 修改：`README.md`
- 创建：`.github/workflows/test.yml`

- [ ] **步骤 1：编写失败的部署配置检查**

```ts
it("does not commit production secrets", async () => {
  const tracked = await gitTrackedFiles();
  expect(tracked).not.toContain(".dev.vars");
  expect(await readFile("wrangler.jsonc", "utf8")).not.toMatch(/api[_-]?key\s*[:=]/i);
});
```

- [ ] **步骤 2：运行测试验证失败或新增检查失败**

运行：`npx vitest run test/delivery-security.test.ts`

预期：若检查尚未接入则 FAIL；修复配置后应通过。

- [ ] **步骤 3：添加 GitHub 验证工作流**

```yaml
name: verify
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - run: npm test
      - run: npm run lint
      - run: npm run build
```

在 README 写明 `.dev.vars.example` 的复制方式、`wrangler dev` 的本地运行方式，以及生产 Secret 只能通过 Cloudflare Dashboard 或 `wrangler secret put` 配置。

- [ ] **步骤 4：运行完整基础验证**

运行：`npm test && npm run lint && npm run build && npx wrangler deploy --dry-run`

预期：全部退出码为 0；dry-run 不创建云端资源且不读取真实 Secret。

- [ ] **步骤 5：提交**

```bash
git add .github/workflows/test.yml README.md test/delivery-security.test.ts
git commit -m "ci: verify cloudflare foundation"
```

## 后续计划顺序

1. `2026-07-29-cloudflare-data-and-jobs.md`：D1 异步 Repository、R2 文件、Queue、共享 AI Key 和额度控制。
2. `2026-07-29-cloudflare-browser-and-cutover.md`：浏览器图片/PDF、迁移演练、Cloudflare 资源创建、GitHub 自动发布与正式切换。
