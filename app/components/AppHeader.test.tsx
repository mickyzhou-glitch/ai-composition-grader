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
    vi.restoreAllMocks();
    navigation.replace.mockReset();
    navigation.refresh.mockReset();
  });

  it("显示青藤未来作文批改助手品牌名", () => {
    renderHeader();

    expect(screen.getByText("青藤未来作文批改助手")).toBeInTheDocument();
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
