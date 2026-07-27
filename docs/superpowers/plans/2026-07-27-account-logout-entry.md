# 登录后退出账号入口实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在所有登录后页面的顶部导航中增加可用、可反馈的“退出登录”按钮。

**架构：** 复用现有客户端 `AppHeader` 和 `POST /api/auth/logout`。页头负责退出请求、忙碌状态、错误提示和 App Router 跳转；服务端会话撤销及 Cookie 清理由现有退出路由继续负责。

**技术栈：** Next.js 16 App Router、React、TypeScript、Testing Library、Vitest

---

## 文件结构

- 创建：`app/components/AppHeader.test.tsx`，验证退出入口、请求状态、路由跳转、错误提示和角色显示规则。
- 修改：`app/components/AppHeader.tsx`，封装退出交互并渲染按钮。
- 修改：`app/globals.css`，提供页头错误状态的紧凑样式和移动端适配。

### 任务 1：为页头退出交互建立失败测试

**文件：**
- 创建：`app/components/AppHeader.test.tsx`

- [ ] **步骤 1：编写失败的组件测试**

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppHeader } from "./AppHeader";
import { AuthUserProvider } from "./AuthUserContext";

const navigation = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
}));

function renderHeader(role: "admin" | "teacher" = "teacher") {
  return render(
    <AuthUserProvider role={role}>
      <AppHeader />
    </AuthUserProvider>,
  );
}

describe("AppHeader", () => {
  beforeEach(() => {
    navigation.replace.mockReset();
    navigation.refresh.mockReset();
    vi.restoreAllMocks();
  });

  it("为教师和管理员提供退出入口并保留设置权限规则", () => {
    const teacher = renderHeader("teacher");
    expect(screen.getByRole("button", { name: "退出登录" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "设置" })).not.toBeInTheDocument();
    teacher.unmount();

    renderHeader("admin");
    expect(screen.getByRole("button", { name: "退出登录" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "设置" })).toBeInTheDocument();
  });

  it("退出期间禁用按钮，成功后替换到登录页并刷新路由", async () => {
    let resolveRequest!: (response: Response) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise<Response>((resolve) => { resolveRequest = resolve; }),
    );
    const user = userEvent.setup();
    renderHeader();

    await user.click(screen.getByRole("button", { name: "退出登录" }));
    expect(screen.getByRole("button", { name: "正在退出…" })).toBeDisabled();
    expect(fetch).toHaveBeenCalledWith("/api/auth/logout", { method: "POST" });

    resolveRequest(new Response(
      JSON.stringify({ ok: true, data: { loggedOut: true } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/login"));
    expect(navigation.refresh).toHaveBeenCalledOnce();
  });

  it("退出失败时保留页面并显示服务端错误", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ ok: false, error: { code: "UNAUTHENTICATED", message: "退出失败，请重试" } }),
      { status: 401, headers: { "content-type": "application/json" } },
    ));
    const user = userEvent.setup();
    renderHeader();

    await user.click(screen.getByRole("button", { name: "退出登录" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("退出失败，请重试");
    expect(screen.getByRole("button", { name: "退出登录" })).toBeEnabled();
    expect(navigation.replace).not.toHaveBeenCalled();
  });
});
```

- [ ] **步骤 2：运行测试并确认因退出按钮不存在而失败**

运行：

```bash
npm test -- app/components/AppHeader.test.tsx
```

预期：FAIL，Testing Library 报告找不到名称为“退出登录”的按钮。

- [ ] **步骤 3：提交测试红灯**

```bash
git add app/components/AppHeader.test.tsx
git commit -m "test(auth): 覆盖顶部退出账号交互"
```

### 任务 2：实现最小退出交互

**文件：**
- 修改：`app/components/AppHeader.tsx`
- 修改：`app/globals.css`
- 测试：`app/components/AppHeader.test.tsx`

- [ ] **步骤 1：在页头实现退出请求、状态与导航**

将 `AppHeader` 扩展为：

```tsx
"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { apiFetch, errorMessage } from "../lib/api";
import { AsyncButton } from "./AsyncButton";
import { useAuthRole } from "./AuthUserContext";

export function AppHeader({ compact = false, userRole }: { compact?: boolean; userRole?: "admin" | "teacher" }) {
  const contextRole = useAuthRole();
  const role = userRole ?? contextRole;
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");

  async function logout() {
    setLoggingOut(true);
    setLogoutError("");
    try {
      await apiFetch<{ loggedOut: boolean }>("/api/auth/logout", { method: "POST" });
      router.replace("/login");
      router.refresh();
    } catch (error) {
      setLogoutError(errorMessage(error));
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <header className={compact ? "app-header app-header--compact" : "app-header"}>
      <Link className="wordmark" href="/" aria-label="返回批改历史首页">
        <span className="seal" aria-hidden="true">批</span>
        <span>朱批 <b>·</b> AI作文批改助手</span>
      </Link>
      <nav className="header-actions" aria-label="主要操作">
        <Link className="button button--primary" href="/new">新建作文批改</Link>
        {role === "admin" ? <Link className="button button--quiet" href="/settings">设置</Link> : null}
        <AsyncButton
          className="button button--quiet"
          type="button"
          busy={loggingOut}
          busyLabel="正在退出…"
          onClick={() => void logout()}
        >
          退出登录
        </AsyncButton>
        {logoutError ? <span className="header-action-error" role="alert">{logoutError}</span> : null}
      </nav>
    </header>
  );
}
```

- [ ] **步骤 2：添加紧凑错误样式**

在 `app/globals.css` 的页头样式附近增加：

```css
.header-action-error {
  flex-basis: 100%;
  color: var(--red);
  font-size: .78rem;
  font-weight: 700;
  text-align: right;
}
```

在移动端媒体查询中增加：

```css
.header-action-error { font-size: .72rem; }
```

- [ ] **步骤 3：运行聚焦测试并确认通过**

运行：

```bash
npm test -- app/components/AppHeader.test.tsx
```

预期：3 项测试全部 PASS。

- [ ] **步骤 4：运行全量验证**

运行：

```bash
npm test
npm run build
git diff --check
```

预期：418 项现有测试加 3 项新测试全部通过；生产构建成功；差异检查无输出。

- [ ] **步骤 5：提交实现**

```bash
git add app/components/AppHeader.tsx app/globals.css
git commit -m "feat(auth): 添加顶部退出登录入口"
```

### 任务 3：部署并验证运行服务

**文件：**
- 不修改代码文件

- [ ] **步骤 1：重启网页与 Worker 服务加载新构建**

```bash
npm run private-beta -- stop
npm run private-beta -- start
npm run private-beta -- tunnel
```

- [ ] **步骤 2：验证外网健康接口**

运行：

```bash
curl --fail --max-time 15 https://cursive-preflight-mounting.ngrok-free.dev/api/health
```

预期：返回 `{"ok":true,"data":{"status":"up"}}`。

- [ ] **步骤 3：检查仓库最终状态**

```bash
git status --short --branch
```

预期：位于 `codex/private-beta-implementation`，工作区干净。
