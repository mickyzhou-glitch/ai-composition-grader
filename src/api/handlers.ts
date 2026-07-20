import { z, ZodError } from "zod";

import type { OpenAIClientFactory, TestConnectionInput } from "../ai/openai-review-adapter";
import { testOpenAIConnection } from "../ai/openai-review-adapter";
import {
  annotationSchema,
  assignmentConfigSchema,
  evaluationReportSchema,
} from "../domain/contracts";
import type { ImageService } from "../images/image-service";
import { normalizeBaseUrl, type SaveSettingsInput, type SettingsView } from "../settings/settings-service";
import type { ReviewService } from "../services/review-service";

type RouteContext = { params: Promise<{ id: string }> };

interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

function ok(data: unknown, status = 200): Response {
  return Response.json({ ok: true, data }, { status });
}

function failure(error: unknown): Response {
  let status = 500;
  let body: ErrorBody = {
    code: "INTERNAL_ERROR",
    message: "服务暂时不可用",
  };
  if (error instanceof ZodError) {
    status = 400;
    body = {
      code: "VALIDATION_ERROR",
      message: "请求参数无效",
      details: error.flatten(),
    };
  } else if (error instanceof SyntaxError || error instanceof TypeError) {
    status = 400;
    body = { code: "VALIDATION_ERROR", message: error.message };
  } else if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    status = error.status;
    body = {
      code: error.code,
      message:
        "message" in error && typeof error.message === "string"
          ? error.message
          : "请求失败",
      ...( "details" in error && error.details !== undefined
        ? { details: error.details }
        : {}),
    };
  } else if (
    error instanceof Error &&
    error.name === "ReviewNotFoundError"
  ) {
    status = 404;
    body = { code: "REVIEW_NOT_FOUND", message: "批改记录不存在" };
  }
  return Response.json({ ok: false, error: body }, { status });
}

async function readJson(request: Request): Promise<unknown> {
  return request.json();
}

const settingsWriteSchema = z
  .object({
    baseUrl: z.string().trim().min(1),
    model: z.string().trim().min(1),
    apiKey: z.string().min(1).optional(),
  })
  .strict();

const settingsTestSchema = settingsWriteSchema.extend({
  apiKey: z.string().min(1).optional(),
});

interface SettingsRouteService {
  get(): Promise<SettingsView | null>;
  getSecret(): Promise<string | null>;
  save(input: SaveSettingsInput): Promise<SettingsView>;
}

interface SettingsHandlerDependencies {
  settingsService: SettingsRouteService;
  testConnection?: (input: TestConnectionInput) => Promise<unknown>;
  clientFactory?: OpenAIClientFactory;
}

export function createSettingsRouteHandlers(
  dependencies: SettingsHandlerDependencies,
) {
  const connectionTest =
    dependencies.testConnection ??
    ((input: TestConnectionInput) =>
      testOpenAIConnection(input, dependencies.clientFactory));

  async function resolveInput(
    request: Request,
    schema: typeof settingsWriteSchema | typeof settingsTestSchema,
  ) {
    const parsed = schema.parse(await readJson(request));
    const apiKey = parsed.apiKey ?? (await dependencies.settingsService.getSecret());
    if (!apiKey) throw new TypeError("apiKey must be configured");
    return {
      baseUrl: normalizeBaseUrl(parsed.baseUrl),
      model: parsed.model.trim(),
      apiKey,
      suppliedApiKey: parsed.apiKey,
    };
  }

  return {
    async GET() {
      try {
        return ok(await dependencies.settingsService.get());
      } catch (error) {
        return failure(error);
      }
    },
    async PUT(request: Request) {
      try {
        const input = await resolveInput(request, settingsWriteSchema);
        await connectionTest({
          baseUrl: input.baseUrl,
          model: input.model,
          apiKey: input.apiKey,
        });
        return ok(
          await dependencies.settingsService.save({
            baseUrl: input.baseUrl,
            model: input.model,
            ...(input.suppliedApiKey === undefined
              ? {}
              : { apiKey: input.suppliedApiKey }),
          }),
        );
      } catch (error) {
        return failure(error);
      }
    },
    async POST_TEST(request: Request) {
      try {
        const input = await resolveInput(request, settingsTestSchema);
        await connectionTest({
          baseUrl: input.baseUrl,
          model: input.model,
          apiKey: input.apiKey,
        });
        return ok({ connected: true });
      } catch (error) {
        return failure(error);
      }
    },
  };
}

const createReviewSchema = z.object({ config: assignmentConfigSchema }).strict();
const updateReviewSchema = z
  .object({
    config: assignmentConfigSchema.optional(),
    report: evaluationReportSchema.optional(),
    annotations: z.array(annotationSchema).optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.config !== undefined ||
      input.report !== undefined ||
      input.annotations !== undefined,
    {
    message: "at least one review field is required",
    },
  );

export function createReviewsRouteHandlers(dependencies: {
  reviewService: ReviewService;
}) {
  return {
    async GET() {
      try {
        return ok(dependencies.reviewService.list());
      } catch (error) {
        return failure(error);
      }
    },
    async POST(request: Request) {
      try {
        const input = createReviewSchema.parse(await readJson(request));
        return ok(await dependencies.reviewService.create(input.config), 201);
      } catch (error) {
        return failure(error);
      }
    },
  };
}

export function createReviewRouteHandlers(dependencies: {
  reviewService: ReviewService;
}) {
  return {
    async GET(_request: Request, context: RouteContext) {
      try {
        return ok(dependencies.reviewService.get((await context.params).id));
      } catch (error) {
        return failure(error);
      }
    },
    async PATCH(request: Request, context: RouteContext) {
      try {
        const input = updateReviewSchema.parse(await readJson(request));
        return ok(dependencies.reviewService.update((await context.params).id, input));
      } catch (error) {
        return failure(error);
      }
    },
    async DELETE(_request: Request, context: RouteContext) {
      try {
        await dependencies.reviewService.delete((await context.params).id);
        return ok({ deleted: true });
      } catch (error) {
        return failure(error);
      }
    },
  };
}

export function createReviewImagesRouteHandlers(dependencies: {
  imageService: ImageService;
}) {
  return {
    async POST(request: Request, context: RouteContext) {
      try {
        const form = await request.formData();
        const entries = form.getAll("images").length > 0
          ? form.getAll("images")
          : form.getAll("files");
        const files = await Promise.all(
          entries.map(async (entry) => {
            if (!(entry instanceof File)) {
              throw new TypeError("multipart images entries must be files");
            }
            return {
              originalName: entry.name,
              mimeType: entry.type,
              data: new Uint8Array(await entry.arrayBuffer()),
            };
          }),
        );
        return ok(
          await dependencies.imageService.upload((await context.params).id, files),
        );
      } catch (error) {
        return failure(error);
      }
    },
    async PATCH(request: Request, context: RouteContext) {
      try {
        return ok(
          await dependencies.imageService.update(
            (await context.params).id,
            (await readJson(request)) as never,
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
  };
}

export function createAnalyzeRouteHandlers(dependencies: {
  reviewService: ReviewService;
}) {
  return {
    async POST(_request: Request, context: RouteContext) {
      try {
        return ok(await dependencies.reviewService.analyze((await context.params).id));
      } catch (error) {
        return failure(error);
      }
    },
  };
}
