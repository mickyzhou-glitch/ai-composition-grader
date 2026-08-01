import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
  replace: vi.fn(),
}));

const documentNavigation = vi.hoisted(() => ({
  replace: vi.fn(),
}));

const passwordProof = vi.hoisted(() => ({
  create: vi.fn(),
}));

const legacyPasswordProof = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
}));

vi.mock("../lib/document-navigation", () => ({
  replaceDocument: documentNavigation.replace,
}));

vi.mock("./login-mode", () => ({
  shouldUsePasswordProofLogin: () => true,
}));

vi.mock("../../src/auth/password-proof-browser", () => ({
  createBrowserLoginProof: passwordProof.create,
}));

vi.mock("../../src/auth/legacy-password-proof-browser", () => ({
  createLegacyPasswordLogin: legacyPasswordProof.create,
}));

import LoginPage from "./page";

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  }));
}

describe("登录页", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    navigation.replace.mockReset();
    documentNavigation.replace.mockReset();
    passwordProof.create.mockReset();
    legacyPasswordProof.create.mockReset();
  });

  it("脚本接管表单前不会原生提交账号密码", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(<LoginPage />);

    const form = container.querySelector("form");
    const username = container.querySelector<HTMLInputElement>('input[name="username"]');
    const password = container.querySelector<HTMLInputElement>('input[name="password"]');
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]');

    expect(form).toHaveAttribute("method", "post");
    expect(username).toBeDisabled();
    expect(password).toBeDisabled();
    expect(submit).toBeDisabled();
  });

  it("存量账号按挑战模式直接完成一次迁移登录", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/auth/login/challenge") {
        return jsonResponse({ ok: true, data: {
          id: "legacy-1",
          mode: "legacy",
          salt: "c2FsdA",
          nonce: "bm9uY2U",
          expiresAt: "2026-08-01T08:10:00.000Z",
          legacy: { salt: "c2FsdA", memorySize: 65_536, iterations: 3, parallelism: 4, hashLength: 32 },
        } });
      }
      if (url === "/api/auth/login/legacy/complete") {
        return jsonResponse({ ok: true, data: { mustChangePassword: false } });
      }
      return jsonResponse({ ok: false, error: { code: "UNEXPECTED_REQUEST", message: url } }, 500);
    });
    legacyPasswordProof.create.mockResolvedValue({ proof: "legacy-proof", verifier: "new-verifier" });
    passwordProof.create.mockResolvedValue("modern-proof");
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText("用户名"), "teacher.one");
    await user.type(screen.getByLabelText("密码"), "correct password");
    await user.click(screen.getByRole("button", { name: "登录" }));

    await waitFor(() => expect(documentNavigation.replace).toHaveBeenCalledWith("/"));
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(passwordProof.create).not.toHaveBeenCalled();
    expect(legacyPasswordProof.create).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/auth/login/challenge",
      "/api/auth/login/legacy/complete",
    ]);
  });

  it("安全登录组件不可用时给出可操作提示并清空密码", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      if (String(input) === "/api/auth/login/challenge") {
        return jsonResponse({ ok: true, data: {
          id: "proof-1",
          mode: "proof",
          salt: "c2FsdA",
          nonce: "bm9uY2U",
          expiresAt: "2026-08-01T08:10:00.000Z",
        } });
      }
      return jsonResponse({ ok: false, error: { code: "UNEXPECTED_REQUEST", message: String(input) } }, 500);
    });
    passwordProof.create.mockRejectedValue(new Error("WebAssembly compilation blocked by Content Security Policy"));
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText("用户名"), "teacher.one");
    await user.type(screen.getByLabelText("密码"), "correct password");
    await user.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("当前浏览器无法完成安全登录，请使用最新版系统浏览器后重试");
    expect(screen.getByLabelText("密码")).toHaveValue("");
  });

  it.each([
    "Failed to fetch dynamically imported module",
    "Importing a module script failed.",
  ])("安全登录组件加载失败时提示用户检查网络并刷新：%s", async (failureMessage) => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      if (String(input) === "/api/auth/login/challenge") {
        return jsonResponse({ ok: true, data: {
          id: "proof-1",
          mode: "proof",
          salt: "c2FsdA",
          nonce: "bm9uY2U",
          expiresAt: "2026-08-01T08:10:00.000Z",
        } });
      }
      return jsonResponse({ ok: false, error: { code: "UNEXPECTED_REQUEST", message: String(input) } }, 500);
    });
    passwordProof.create.mockRejectedValue(new TypeError(failureMessage));
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText("用户名"), "teacher.one");
    await user.type(screen.getByLabelText("密码"), "correct password");
    await user.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("安全登录组件加载失败，请检查网络后刷新页面重试");
    expect(screen.getByLabelText("密码")).toHaveValue("");
  });
});
