export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

interface ApiSuccess<T> {
  ok: true;
  data: T;
}

interface ApiFailure {
  ok: false;
  error: ApiErrorBody;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = "REQUEST_FAILED",
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function apiFetch<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  let envelope: ApiSuccess<T> | ApiFailure;
  try {
    envelope = (await response.json()) as ApiSuccess<T> | ApiFailure;
  } catch {
    throw new ApiError("服务器返回了无法识别的响应", response.status);
  }
  if (!response.ok || !envelope.ok) {
    const error = envelope.ok
      ? { code: "REQUEST_FAILED", message: `请求失败（${response.status}）` }
      : envelope.error;
    throw new ApiError(error.message, response.status, error.code, error.details);
  }
  return envelope.data;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请稍后重试";
}
