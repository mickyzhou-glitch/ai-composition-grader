// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { completionWithFinish, parseJsonResponse } from "./adapter-shared";

describe("模型响应边界", () => {
  it("修复字符串内的裸换行和字符串外的尾逗号，保留正文标点", () => {
    expect(parseJsonResponse('说明\n```json\n{"text":"第一行\n第二行,}","items":[1,],}\n```\n完成')).toEqual({
      text: "第一行\n第二行,}", items: [1],
    });
  });

  it("提取完整对象时忽略后续说明里的花括号", () => {
    expect(parseJsonResponse('结果：{"text":"括号 } 和转义引号 \\""}。说明 {无关}')).toEqual({ text: '括号 } 和转义引号 "' });
  });

  it.each(['{"text":"未完', '{"items":[1,', '{"text":"未转义"引号"}'])("不猜测补全损坏或截断的 JSON：%s", (content) => {
    expect(() => parseJsonResponse(content)).toThrow(SyntaxError);
  });

  it.each(["TimeoutError", "APIConnectionTimeoutError", "AbortError"])("保留请求超时／中止分类：%s", async (name) => {
    const create = vi.fn().mockRejectedValue(Object.assign(new Error("request interrupted"), { name }));
    await expect(completionWithFinish({ chat: { completions: { create } } }, {})).rejects.toMatchObject({
      code: "AI_REQUEST_FAILED", upstreamCode: "request_timeout",
    });
  });

  it.each([{}, { choices: [] }, { choices: [{}] }, { choices: [{ message: { content: [] } }] }])("上游成功但响应信封损坏时给出稳定错误码：%j", async (response) => {
    const create = vi.fn().mockResolvedValue(response);
    await expect(completionWithFinish({ chat: { completions: { create } } }, {})).rejects.toMatchObject({
      code: "AI_INVALID_RESPONSE", upstreamCode: "response_envelope",
    });
  });
});
