import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));

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
          vision: { baseUrl: "https://vision.example.com/v1", model: "vision-model", keyConfigured: true },
          content: { baseUrl: "https://content.example.com/v1", model: "writer-model", keyConfigured: true },
        },
      }),
    );

    render(<SettingsPage />);

    expect(await screen.findByRole("heading", { name: "拍照识图模型" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "作文内容模型" })).toBeInTheDocument();
    expect(screen.getByLabelText("拍照识图模型名称")).toHaveValue("vision-model");
    expect(screen.getByLabelText("作文内容模型名称")).toHaveValue("writer-model");
    expect(screen.getByLabelText("拍照识图 API Key")).toHaveValue("");
    expect(screen.getByLabelText("作文内容 API Key")).toHaveValue("");
    expect(screen.getAllByText("密钥已配置，留空将继续使用原密钥")).toHaveLength(2);
  });

  it("测试连接失败时展示服务端错误", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() =>
        response({
          ok: true,
          data: {
            vision: { baseUrl: "https://vision.example.com/v1", model: "vision", keyConfigured: false },
            content: { baseUrl: "https://content.example.com/v1", model: "grader", keyConfigured: false },
          },
        }),
      )
      .mockImplementationOnce(() =>
        response({ ok: false, error: { code: "CONNECTION_FAILED", message: "无法连接模型" } }, 502),
      );
    const user = userEvent.setup();
    render(<SettingsPage />);

    await screen.findByDisplayValue("grader");
    await user.type(screen.getByLabelText("作文内容 API Key"), "secret");
    await user.click(screen.getByRole("button", { name: "测试作文内容模型" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("无法连接模型");
  });

  it("保存内容模型时只发送 content 角色设置", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => response({ ok: true, data: {
        vision: { baseUrl: "https://vision.example.com/v1", model: "vision", keyConfigured: true },
        content: { baseUrl: "https://content.example.com/v1", model: "writer", keyConfigured: true },
      } }))
      .mockImplementationOnce(() => response({ ok: true, data: {
        baseUrl: "https://content.example.com/v1", model: "writer-2", keyConfigured: true,
      } }));
    const user = userEvent.setup();
    render(<SettingsPage />);

    const model = await screen.findByLabelText("作文内容模型名称");
    await user.clear(model);
    await user.type(model, "writer-2");
    await user.click(screen.getByRole("button", { name: "保存作文内容模型" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][0]).toBe("/api/settings/content");
    expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)).toEqual({
      baseUrl: "https://content.example.com/v1",
      model: "writer-2",
    });
  });
});
