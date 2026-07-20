import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import SettingsPage from "./page";

function response(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("设置页", () => {
  afterEach(() => vi.restoreAllMocks());

  it("只显示密钥已配置状态，不回显密钥", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      response({
        ok: true,
        data: {
          baseUrl: "https://api.example.com/v1",
          model: "grader-model",
          keyConfigured: true,
        },
      }),
    );

    render(<SettingsPage />);

    expect(await screen.findByDisplayValue("grader-model")).toBeInTheDocument();
    expect(screen.getByLabelText("API Key")).toHaveValue("");
    expect(screen.getByText("密钥已配置，留空将继续使用原密钥")).toBeInTheDocument();
  });

  it("测试连接失败时展示服务端错误", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() =>
        response({
          ok: true,
          data: { baseUrl: "https://api.example.com/v1", model: "grader", keyConfigured: false },
        }),
      )
      .mockImplementationOnce(() =>
        response({ ok: false, error: { code: "CONNECTION_FAILED", message: "无法连接模型" } }, 502),
      );
    const user = userEvent.setup();
    render(<SettingsPage />);

    await screen.findByDisplayValue("grader");
    await user.type(screen.getByLabelText("API Key"), "secret");
    await user.click(screen.getByRole("button", { name: "测试连接" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("无法连接模型");
  });
});
