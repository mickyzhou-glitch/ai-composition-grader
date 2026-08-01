import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, apiFetch } from "../lib/api";
import { deriveBrowserPasswordVerifier } from "../../src/auth/password-proof-browser";
import ChangePasswordPage from "./page";

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));
const documentNavigation = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => navigation }));
vi.mock("../lib/document-navigation", () => ({ replaceDocument: documentNavigation.replace }));
vi.mock("../lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/api")>();
  return { ...original, apiFetch: vi.fn() };
});
vi.mock("../../src/auth/password-proof-browser", () => ({ deriveBrowserPasswordVerifier: vi.fn() }));

describe("修改密码页", () => {
  beforeEach(() => {
    navigation.replace.mockReset();
    documentNavigation.replace.mockReset();
    vi.mocked(apiFetch).mockReset();
    vi.mocked(deriveBrowserPasswordVerifier).mockReset();
  });

  it("脚本接管表单前不会原生提交新密码", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(<ChangePasswordPage />);

    expect(container.querySelector("form")).toHaveAttribute("method", "post");
    expect(container.querySelector<HTMLInputElement>("#new-password")).toBeDisabled();
    expect(container.querySelector<HTMLInputElement>("#confirm-password")).toBeDisabled();
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')).toBeDisabled();
  });

  it("认证失效时整页替换到登录页", async () => {
    vi.mocked(apiFetch).mockRejectedValue(new ApiError("需要登录", 401, "UNAUTHENTICATED"));

    render(<ChangePasswordPage />);

    await waitFor(() => expect(documentNavigation.replace).toHaveBeenCalledWith("/login"));
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("认证服务临时失败时保留当前页面并显示可重试提示", async () => {
    vi.mocked(apiFetch).mockRejectedValue(new ApiError("认证服务暂时不可用", 503, "AUTHENTICATION_UNAVAILABLE"));

    render(<ChangePasswordPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("认证服务暂时不可用，请稍后重试");
    expect(documentNavigation.replace).not.toHaveBeenCalled();
  });

  it("保存新密码后整页替换到工作台", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ id: "u1" });
    vi.mocked(deriveBrowserPasswordVerifier).mockResolvedValue(new Uint8Array(32).fill(7));
    const user = userEvent.setup();
    render(<ChangePasswordPage />);

    await waitFor(() => expect(screen.getByRole("button", { name: "保存新密码" })).toBeEnabled());
    await user.type(screen.getByLabelText("新密码"), "new-password");
    await user.type(screen.getByLabelText("确认新密码"), "new-password");
    await user.click(screen.getByRole("button", { name: "保存新密码" }));

    await waitFor(() => expect(documentNavigation.replace).toHaveBeenCalledWith("/"));
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("安全设置组件加载失败时提示用户检查网络并刷新", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ id: "u1" });
    vi.mocked(deriveBrowserPasswordVerifier).mockRejectedValue(new TypeError("Failed to fetch dynamically imported module"));
    const user = userEvent.setup();
    render(<ChangePasswordPage />);

    await waitFor(() => expect(screen.getByRole("button", { name: "保存新密码" })).toBeEnabled());
    await user.type(screen.getByLabelText("新密码"), "new-password");
    await user.type(screen.getByLabelText("确认新密码"), "new-password");
    await user.click(screen.getByRole("button", { name: "保存新密码" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("安全设置组件加载失败，请检查网络后刷新页面重试");
  });
});
