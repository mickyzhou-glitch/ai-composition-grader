# 静态前端基础实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 使现有教师界面能够以 Next.js 静态导出运行，并把动态登录、受保护路由和打印数据读取改为浏览器调用同源 `/api`，为 Cloudflare Static Assets 部署铺路。

**架构：** 保留 App Router、React 组件和现有 CSS；移除页面层对 `next/headers`、`redirect()`、`getApplicationServices()` 的运行时依赖。动态 API Route Handlers 在后续 Worker API 阶段移出 `app/api`，本阶段先抽离页面的服务端依赖并用静态导出检查锁定边界。

**技术栈：** Next.js 16 static export、React 19、Vitest、Testing Library、Playwright。

---

### 任务 1：为静态构建加入失败检查

**文件：**
- 创建：`test/static-export.test.ts`
- 修改：`next.config.ts`

- [ ] **步骤 1：编写失败测试**

```ts
import config from "../next.config";

it("configures a static export with a deterministic output directory", () => {
  expect(config.output).toBe("export");
  expect(config.distDir).toBe("dist");
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/static-export.test.ts`

预期：FAIL，`config.output` 为 `undefined`。

- [ ] **步骤 3：最小配置实现**

```ts
const nextConfig: NextConfig = {
  output: "export",
  distDir: "dist",
  images: { unoptimized: true },
  // 保留现有 headers；静态产物的等价安全头在 Worker 阶段设置。
};
```

- [ ] **步骤 4：验证**

运行：`npx vitest run test/static-export.test.ts && npm run build`

预期：测试通过；构建可能因动态页面或 API 路由失败，失败输出用于下一任务逐项消除。

### 任务 2：把受保护布局改为浏览器认证门

**文件：**
- 创建：`app/components/RequireAuthenticatedUser.tsx`
- 创建：`app/components/RequireAuthenticatedUser.test.tsx`
- 修改：`app/(protected)/layout.tsx`
- 修改：`app/(protected)/settings/layout.tsx`

- [ ] **步骤 1：编写失败测试**

```tsx
it("redirects an unauthenticated browser to login", async () => {
  mockApiFetch.mockRejectedValue(new ApiError("UNAUTHENTICATED", "Authentication required", 401));
  render(<RequireAuthenticatedUser><p>private</p></RequireAuthenticatedUser>);
  await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
});
```

- [ ] **步骤 2：运行失败测试**

运行：`npx vitest run app/components/RequireAuthenticatedUser.test.tsx`

预期：FAIL，组件不存在。

- [ ] **步骤 3：最小实现**

```tsx
"use client";
export function RequireAuthenticatedUser({ children }: PropsWithChildren) {
  const router = useRouter();
  const { user, error, loading } = useCurrentUser();
  useEffect(() => { if (error?.code === "UNAUTHENTICATED") router.replace("/login"); }, [error, router]);
  if (loading) return <main aria-busy="true" />;
  if (!user) return null;
  if (user.mustChangePassword) { router.replace("/change-password"); return null; }
  return children;
}
```

受保护布局只能渲染该 Client Component；不得导入 `next/headers`、`redirect()` 或 `requirePageUser()`。

- [ ] **步骤 4：验证**

运行：`npx vitest run app/components/RequireAuthenticatedUser.test.tsx app/(protected) && npm run build`

预期：布局单测通过；构建不再因受保护布局读取 Cookie 失败。

### 任务 3：把打印页改为客户端数据页

**文件：**
- 修改：`app/print/reviews/[id]/page.tsx`
- 创建：`app/print/reviews/[id]/PrintReviewPage.tsx`
- 创建：`app/print/reviews/[id]/PrintReviewPage.test.tsx`

- [ ] **步骤 1：编写失败测试**

```tsx
it("loads the review and images through the API instead of server services", async () => {
  render(<PrintReviewPage reviewId="review-1" />);
  await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/reviews/review-1"));
  expect(screen.getByText("打印批改单")).toBeVisible();
});
```

- [ ] **步骤 2：运行失败测试**

运行：`npx vitest run app/print/reviews/[id]/PrintReviewPage.test.tsx`

预期：FAIL，组件不存在。

- [ ] **步骤 3：最小实现**

```tsx
"use client";
export function PrintReviewPage({ reviewId }: { reviewId: string }) {
  const [review, setReview] = useState<Review | null>(null);
  useEffect(() => { void apiFetch<Review>(`/api/reviews/${reviewId}`).then(setReview); }, [reviewId]);
  return review ? <PrintReview review={review} imageUrl={(image) => `/api/reviews/${reviewId}/files?path=${encodeURIComponent(image.path)}`} /> : <main aria-busy="true" />;
}
```

页面参数使用客户端 hook 读取；页面不得使用 `headers()`、`notFound()` 或 `getApplicationServices()`。

- [ ] **步骤 4：验证**

运行：`npx vitest run app/print/reviews/[id] && npm run build`

预期：打印页测试通过；构建不再因打印页运行时服务依赖失败。

### 任务 4：清除动态 API 路由对静态导出的阻塞

**文件：**
- 创建：`src/cloudflare/api-placeholder.ts`
- 修改：`app/api/**`（在后续 Worker 计划实现前转存或移除 Next Route Handler）
- 修改：`package.json`

- [ ] **步骤 1：编写构建失败捕获测试**

```ts
it("has no App Router route handler in the static application tree", async () => {
  const handlers = await glob("app/api/**/route.ts");
  expect(handlers).toEqual([]);
});
```

- [ ] **步骤 2：运行失败测试**

运行：`npx vitest run test/static-export.test.ts`

预期：FAIL，列出当前 `app/api/**/route.ts`。

- [ ] **步骤 3：迁移路由入口到 Worker 适配层**

将每个 Route Handler 的 HTTP 适配职责移动到 `src/cloudflare/routes/`，复用 `src/api/handlers.ts` 内的业务 handler。删除 `app/api` 下的 Route Handler 文件后，客户端继续请求同源 `/api`，由后续 `worker/index.ts` 注册这些适配器。

- [ ] **步骤 4：验证**

运行：`npx vitest run test/static-export.test.ts && npm run build`

预期：静态导出生成 `dist/`，不包含 Next Route Handler 或动态服务端页面错误。

### 任务 5：静态前端阶段回归

**文件：**
- 修改：`README.md`
- 修改：`docs/superpowers/plans/2026-07-29-cloudflare-foundation-auth.md`

- [ ] **步骤 1：记录静态边界**

在 README 说明 `npm run build` 输出 `dist/`，且部署 API 需要 Worker。更新后续计划中 Worker 入口的静态资源目录为 `dist/`。

- [ ] **步骤 2：运行验证**

运行：`npm test && npm run lint && npm run build && npm run test:e2e`

预期：所有命令退出码为 0；静态构建目录存在。

- [ ] **步骤 3：提交**

```bash
git add next.config.ts app src test package.json README.md docs/superpowers/plans
git commit -m "feat(frontend): prepare static Cloudflare delivery"
```
