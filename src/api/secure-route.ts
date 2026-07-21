import { AuthRequestError, assertTrustedWriteOrigin, requireAdminApiUser, requireApiUser } from "../auth/request-auth";
import type { AuthenticatedUser } from "../auth/auth-types";

type RouteAction = (user: AuthenticatedUser) => Promise<Response> | Response;

const SAFE_MESSAGES: Record<string, string> = {
  VALIDATION_ERROR: "请求参数无效",
  REVIEW_NOT_FOUND: "批改记录不存在",
  NOT_FOUND: "资源不存在",
  FILE_NOT_FOUND: "文件不存在",
  INVALID_FILE_PATH: "请求参数无效",
  REVISION_CONFLICT: "数据已被更新，请刷新后重试",
  ANALYSIS_CONFLICT: "分析任务正在进行，请稍后重试",
  IMAGES_REQUIRED: "请先上传作文图片",
  IMAGE_COUNT_INVALID: "图片数量无效",
  IMAGE_TOO_LARGE: "图片文件过大",
  IMAGE_PIXEL_LIMIT_EXCEEDED: "图片尺寸过大",
  UNSUPPORTED_IMAGE_TYPE: "不支持的图片格式",
  INVALID_IMAGE: "图片内容无效",
  UNSUPPORTED_HEIC: "当前环境不支持 HEIC 图片",
  INVALID_IMAGE_TRANSFORM: "图片变换参数无效",
  PDF_CONTENT_INCOMPLETE: "批改内容尚未完成",
  PDF_ANALYSIS_IN_PROGRESS: "分析任务正在进行，请稍后重试",
  PDF_ENGINE_MISSING: "PDF 服务暂时不可用",
  PDF_UNTRUSTED_NAVIGATION: "PDF 服务暂时不可用",
  PDF_TIMEOUT: "PDF 服务暂时不可用",
  AI_REQUEST_FAILED: "AI 服务暂时不可用",
  AI_RESPONSE_INVALID: "AI 服务暂时不可用",
  SETTINGS_INVALID: "设置参数无效",
  SETTINGS_UNAVAILABLE: "设置服务暂时不可用",
  UNTRUSTED_ORIGIN: "请求来源不受信任",
  UNAUTHENTICATED: "需要登录",
  PASSWORD_CHANGE_REQUIRED: "请先修改初始密码",
  FORBIDDEN: "无权执行此操作",
  INTERNAL_ERROR: "服务暂时不可用",
};

function codeForStatus(status: number): string {
  if (status === 401) return "UNAUTHENTICATED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status >= 400 && status < 500) return "VALIDATION_ERROR";
  return "INTERNAL_ERROR";
}

function safeStatus(status: number): number {
  if (status >= 400 && status < 600) return status;
  return 500;
}

function errorBody(code: string, status: number): Response {
  // Never reflect arbitrary provider/SQLite error codes. Only codes with an
  // explicitly reviewed public meaning are allowed through this boundary.
  const safeCode = Object.prototype.hasOwnProperty.call(SAFE_MESSAGES, code)
    ? code
    : codeForStatus(status);
  return Response.json(
    { ok: false, error: { code: safeCode, message: SAFE_MESSAGES[safeCode] ?? SAFE_MESSAGES[codeForStatus(status)] } },
    { status: safeStatus(status) },
  );
}

/** Convert handler errors to a deliberately small, non-sensitive public envelope. */
export async function sanitizeApiResponse(response: Response): Promise<Response> {
  if (response.status < 400) return response;
  let code: unknown;
  try {
    const body = await response.clone().json() as { error?: { code?: unknown } };
    code = body?.error?.code;
  } catch {
    // A non-JSON failure (for example from an adapter) must not be passed through.
  }
  return errorBody(typeof code === "string" ? code : codeForStatus(response.status), response.status);
}

export function authErrorResponse(error: unknown): Response {
  if (error instanceof AuthRequestError) {
    return errorBody(error.code, error.status);
  }
  return errorBody("INTERNAL_ERROR", 500);
}

export async function runProtectedApi(
  request: Request,
  action: RouteAction,
  options: { write?: boolean; admin?: boolean } = {},
): Promise<Response> {
  try {
    // Authentication and the first-password gate deliberately precede Origin and
    // all resource/body parsing. This keeps the API matrix deterministic.
    const user = options.admin
      ? await requireAdminApiUser(request)
      : await requireApiUser(request);
    if (options.write) assertTrustedWriteOrigin(request);
    return sanitizeApiResponse(await action(user));
  } catch (error) {
    return authErrorResponse(error);
  }
}
