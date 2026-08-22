import { z, ZodError } from "zod";

import type { OpenAIClientFactory, TestConnectionInput } from "../ai/openai-review-adapter";
import { testOpenAIConnection } from "../ai/openai-review-adapter";
import {
  annotationSchema,
  assignmentConfigSchema,
  evaluationReportSchema,
  MAX_REVIEW_IMAGES,
  PRIVACY_NOTICE_VERSION,
  studentNameSchema,
} from "../domain/contracts";
import type { ImageService } from "../images/image-service";
import type { PdfService } from "../pdf/pdf-service";
import type { PdfBatchService } from "../pdf/pdf-batch-service";
import {
  normalizeBaseUrl,
  type SaveSettingsInput,
  type SettingsCandidateTester,
  type SettingsView,
} from "../settings/settings-service";
import type { ReviewService } from "../services/review-service";
import { reviewImageVariants, type ReviewImageVariant } from "../services/review-service";
import type { AnalysisJobService } from "../jobs/analysis-job-service";
import type { AssignmentGuidance, AssignmentGuidanceInput } from "../ai/assignment-guidance-adapter";

const MAX_MULTIPART_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

type RouteContext = { params: Promise<{ id: string }> };

interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

function ok(data: unknown, status = 200): Response {
  return Response.json({ ok: true, data }, { status });
}

function routeError(code: string, message: string, status: number): Error {
  return Object.assign(new Error(message), { code, status });
}

function reviewImageDto(image: {
  id: number;
  position: number;
  originalName: string;
  mimeType: string;
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  crop: unknown;
}) {
  return {
    id: image.id,
    position: image.position,
    originalName: image.originalName,
    mimeType: image.mimeType,
    width: image.width,
    height: image.height,
    rotation: image.rotation,
    crop: image.crop,
  };
}

function reviewDto(review: {
  id: string;
  status: unknown;
  studentName: string;
  config: unknown;
  report: unknown;
  revision: number;
  createdAt: unknown;
  updatedAt: unknown;
  annotations: unknown;
  images: Array<Parameters<typeof reviewImageDto>[0]>;
  pdfFilename?: string | null;
  pdfPath?: string | null;
  pdfRevision?: number | null;
  exportedAt?: unknown;
  teacherReviewedAt?: unknown;
  expiresAt?: unknown;
}) {
  const hasPdf =
    typeof review.pdfFilename === "string" &&
    review.pdfFilename.length > 0 &&
    review.pdfPath === `pdf/${review.pdfFilename}` &&
    review.pdfRevision === review.revision &&
    review.exportedAt != null;
  return {
    id: review.id,
    status: review.status,
    studentName: review.studentName,
    config: review.config,
    report: review.report,
    revision: review.revision,
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
    annotations: review.annotations,
    images: review.images.map(reviewImageDto),
    hasPdf,
    pdfFilename: hasPdf ? review.pdfFilename : null,
    teacherReviewedAt: review.teacherReviewedAt ?? null,
    expiresAt: review.expiresAt ?? null,
  };
}

function imageCollectionDto(result: {
  images: Array<Parameters<typeof reviewImageDto>[0]>;
}) {
  return { ...result, images: result.images.map(reviewImageDto) };
}

export async function readMultipartWithLimit(
  request: Request,
  maxBytes = MAX_MULTIPART_BYTES,
): Promise<FormData> {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > maxBytes
  ) {
    throw routeError("PAYLOAD_TOO_LARGE", "上传请求不能超过 64MB", 413);
  }
  if (!request.body) return request.formData();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // The size error remains authoritative if cancelling the source fails.
        }
        throw routeError("PAYLOAD_TOO_LARGE", "上传请求不能超过 64MB", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const headers = new Headers(request.headers);
  headers.set("content-length", String(totalBytes));
  const bufferedRequest = new Request(request.url, {
    method: request.method,
    headers,
    body: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), totalBytes),
  });
  return bufferedRequest.formData();
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

const assignmentGuidanceSchema = z.object({
  title: z.string().trim().min(1).max(120),
  grade: z.string().trim().min(1).max(120),
  targetCharacters: z.number().int().positive().max(3_000),
}).strict();

interface SettingsRouteService {
  get(): Promise<SettingsView | null>;
  testCandidate(
    input: SaveSettingsInput,
    tester: SettingsCandidateTester,
    save: boolean,
  ): Promise<SettingsView | void>;
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

  async function readCandidate(
    request: Request,
    schema: typeof settingsWriteSchema | typeof settingsTestSchema,
  ) {
    const parsed = schema.parse(await readJson(request));
    return {
      baseUrl: normalizeBaseUrl(parsed.baseUrl),
      model: parsed.model.trim(),
      ...(parsed.apiKey === undefined ? {} : { apiKey: parsed.apiKey }),
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
        return ok(
          await dependencies.settingsService.testCandidate(
            await readCandidate(request, settingsWriteSchema),
            connectionTest,
            true,
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
    async POST_TEST(request: Request) {
      try {
        await dependencies.settingsService.testCandidate(
          await readCandidate(request, settingsTestSchema),
          connectionTest,
          false,
        );
        return ok({ connected: true });
      } catch (error) {
        return failure(error);
      }
    },
  };
}

export function createAssignmentGuidanceRouteHandlers(dependencies: {
  generate(input: AssignmentGuidanceInput): Promise<AssignmentGuidance>;
}) {
  return {
    async POST(request: Request) {
      try {
        const input = assignmentGuidanceSchema.parse(await readJson(request));
        return ok(await dependencies.generate(input));
      } catch (error) {
        return failure(error);
      }
    },
  };
}

const createReviewSchema = z
  .object({
    config: assignmentConfigSchema,
    studentName: studentNameSchema.optional(),
  })
  .strict();
const updateReviewSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    studentName: studentNameSchema.optional(),
    config: assignmentConfigSchema.optional(),
    report: evaluationReportSchema.optional(),
    annotations: z.array(annotationSchema).optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.config !== undefined ||
      input.studentName !== undefined ||
      input.report !== undefined ||
      input.annotations !== undefined,
    {
    message: "at least one review field is required",
    },
  );
const multipartRevisionSchema = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().nonnegative());

export function createReviewsRouteHandlers(dependencies: {
  reviewService: ReviewService;
  ownerId: string;
}) {
  return {
    async GET() {
      try {
        return ok(dependencies.reviewService.list(dependencies.ownerId).map(reviewDto));
      } catch (error) {
        return failure(error);
      }
    },
    async POST(request: Request) {
      try {
        const input = createReviewSchema.parse(await readJson(request));
        return ok(
          reviewDto(
            await dependencies.reviewService.create(
              dependencies.ownerId,
              input.config,
              input.studentName,
            ),
          ),
          201,
        );
      } catch (error) {
        return failure(error);
      }
    },
  };
}

export function createSavedAssignmentsRouteHandlers(dependencies: {
  reviewService: Pick<ReviewService, "listSavedAssignments" | "deleteSavedAssignment">;
  ownerId: string;
}) {
  return {
    async GET() {
      try {
        return ok(dependencies.reviewService.listSavedAssignments(dependencies.ownerId));
      } catch (error) {
        return failure(error);
      }
    },
    async DELETE(_request: Request, context: RouteContext) {
      try {
        await dependencies.reviewService.deleteSavedAssignment(dependencies.ownerId, (await context.params).id);
        return ok({ deleted: true });
      } catch (error) {
        return failure(error);
      }
    },
  };
}

export function createReviewRouteHandlers(dependencies: {
  reviewService: ReviewService;
  ownerId: string;
}) {
  return {
    async GET(_request: Request, context: RouteContext) {
      try {
        return ok(reviewDto(dependencies.reviewService.get(dependencies.ownerId, (await context.params).id)));
      } catch (error) {
        return failure(error);
      }
    },
    async PATCH(request: Request, context: RouteContext) {
      try {
        const input = updateReviewSchema.parse(await readJson(request));
        return ok(reviewDto(await dependencies.reviewService.update(dependencies.ownerId, (await context.params).id, input)));
      } catch (error) {
        return failure(error);
      }
    },
    async DELETE(_request: Request, context: RouteContext) {
      try {
        await dependencies.reviewService.delete(dependencies.ownerId, (await context.params).id);
        return ok({ deleted: true });
      } catch (error) {
        return failure(error);
      }
    },
  };
}

const completeTeacherReviewSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  studentName: studentNameSchema,
  report: evaluationReportSchema,
  annotations: z.array(annotationSchema),
}).strict();

const exportCheckSchema = z.object({
  reviews: z.array(z.object({
    id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u),
    revision: z.number().int().nonnegative(),
  }).strict()).min(1).max(20),
}).strict().refine(
  ({ reviews }) => new Set(reviews.map(({ id }) => id)).size === reviews.length,
  { path: ["reviews"], message: "review ids must be unique" },
);

export function createTeacherReviewQueueRouteHandlers(dependencies: {
  reviewService: Pick<ReviewService, "listTeacherReviewQueue">;
  ownerId: string;
}) {
  return {
    async GET() {
      try {
        return ok(dependencies.reviewService.listTeacherReviewQueue(dependencies.ownerId).map((review) => ({
          id: review.id,
          studentName: review.studentName,
          title: review.config.title,
          status: review.status,
          revision: review.revision,
          createdAt: review.createdAt,
        })));
      } catch (error) {
        return failure(error);
      }
    },
  };
}

export function createTeacherReviewRouteHandlers(dependencies: {
  reviewService: Pick<ReviewService, "completeTeacherReview">;
  ownerId: string;
}) {
  return {
    async POST(request: Request, context: RouteContext) {
      try {
        const input = completeTeacherReviewSchema.parse(await readJson(request));
        return ok(reviewDto(await dependencies.reviewService.completeTeacherReview(
          dependencies.ownerId,
          (await context.params).id,
          input,
        )));
      } catch (error) {
        return failure(error);
      }
    },
  };
}

export function createReviewExportCheckRouteHandlers(dependencies: {
  reviewService: Pick<ReviewService, "checkTeacherReviewedForExport">;
  ownerId: string;
}) {
  return {
    async POST(request: Request) {
      try {
        const { reviews } = exportCheckSchema.parse(await readJson(request));
        if (!dependencies.reviewService.checkTeacherReviewedForExport(dependencies.ownerId, reviews)) {
          throw routeError("EXPORT_NOT_AVAILABLE", "仅已审核且未变更的作文可以导出", 422);
        }
        return ok({ exportable: true });
      } catch (error) {
        return failure(error);
      }
    },
  };
}

const sampleRewriteSchema = z.object({
  instruction: z.string().trim().max(1_000).optional(),
}).strict();

type SampleRewriteContext = { params: Promise<{ id: string; index: string }> };

export function createSampleRewriteRouteHandlers(dependencies: {
  reviewService: Pick<ReviewService, "rewriteSample">;
  ownerId: string;
}) {
  return {
    async POST(request: Request, context: SampleRewriteContext) {
      try {
        const input = sampleRewriteSchema.parse(await readJson(request));
        const { id, index } = await context.params;
        if (!/^\d+$/.test(index)) throw routeError("INVALID_SAMPLE_INDEX", "示范段落序号无效", 400);
        return ok(await dependencies.reviewService.rewriteSample(
          dependencies.ownerId,
          id,
          Number(index),
          input.instruction,
        ));
      } catch (error) {
        return failure(error);
      }
    },
  };
}

const feedbackSectionSchema = z.enum(["strengths", "improvements"]);
type FeedbackRewriteContext = { params: Promise<{ id: string; section: string }> };

export function createFeedbackRewriteRouteHandlers(dependencies: {
  reviewService: Pick<ReviewService, "rewriteFeedback">;
  ownerId: string;
}) {
  return {
    async POST(_request: Request, context: FeedbackRewriteContext) {
      try {
        const { id, section } = await context.params;
        return ok(await dependencies.reviewService.rewriteFeedback(
          dependencies.ownerId,
          id,
          feedbackSectionSchema.parse(section),
        ));
      } catch (error) {
        return failure(error);
      }
    },
  };
}

export function createSamplesRewriteRouteHandlers(dependencies: {
  reviewService: Pick<ReviewService, "rewriteAllSamples">;
  ownerId: string;
}) {
  return {
    async POST(request: Request, context: RouteContext) {
      try {
        const input = sampleRewriteSchema.parse(await readJson(request));
        return ok(await dependencies.reviewService.rewriteAllSamples(
          dependencies.ownerId,
          (await context.params).id,
          input.instruction,
        ));
      } catch (error) {
        return failure(error);
      }
    },
  };
}

export function createReviewImagesRouteHandlers(
  dependencies: { imageService: ImageService; ownerId: string },
  options: { maxMultipartBytes?: number } = {},
) {
  return {
    async POST(request: Request, context: RouteContext) {
      try {
        const form = await readMultipartWithLimit(
          request,
          options.maxMultipartBytes ?? MAX_MULTIPART_BYTES,
        );
        const entries = form.getAll("images").length > 0
          ? form.getAll("images")
          : form.getAll("files");
        const expectedRevision = multipartRevisionSchema.parse(
          form.get("expectedRevision"),
        );
        const privacyConfirmed = form.get("privacyConfirmed") === "true";
        const privacyNoticeVersion = form.get("privacyNoticeVersion");
        const id = (await context.params).id;
        if (
          dependencies.imageService.requiresPrivacyConfirmation(dependencies.ownerId, id) &&
          (!privacyConfirmed || privacyNoticeVersion !== PRIVACY_NOTICE_VERSION)
        ) {
          throw routeError(
            "PRIVACY_CONFIRMATION_REQUIRED",
            "请先确认真实作文上传说明后再上传图片",
            422,
          );
        }
        if (entries.length < 1 || entries.length > MAX_REVIEW_IMAGES) {
          throw routeError(
            "IMAGE_COUNT_INVALID",
            `一次必须上传 1 至 ${MAX_REVIEW_IMAGES} 张图片`,
            400,
          );
        }
        if (entries.some((entry) => !(entry instanceof File))) {
          throw new TypeError("multipart images entries must be files");
        }
        if (entries.some((entry) => (entry as File).size > MAX_IMAGE_BYTES)) {
          throw routeError(
            "IMAGE_TOO_LARGE",
            "单张图片不能超过 20MB",
            413,
          );
        }
        const files = await Promise.all(
          entries.map(async (entry) => {
            const file = entry as File;
            return {
              originalName: file.name,
              mimeType: file.type,
              data: new Uint8Array(await file.arrayBuffer()),
            };
          }),
        );
        return ok(imageCollectionDto(
          await dependencies.imageService.upload(
            dependencies.ownerId,
            id,
            expectedRevision,
            files,
            privacyConfirmed && privacyNoticeVersion === PRIVACY_NOTICE_VERSION
              ? { confirmed: true, version: PRIVACY_NOTICE_VERSION }
              : undefined,
          ),
        ));
      } catch (error) {
        return failure(error);
      }
    },
    async PATCH(request: Request, context: RouteContext) {
      try {
        return ok(imageCollectionDto(
          await dependencies.imageService.update(
            dependencies.ownerId,
            (await context.params).id,
            (await readJson(request)) as never,
          ),
        ));
      } catch (error) {
        return failure(error);
      }
    },
  };
}

export function createAnalyzeRouteHandlers(dependencies: {
  reviewService: ReviewService;
  analysisJobService: AnalysisJobService;
  ownerId: string;
}) {
  return {
    async POST(_request: Request, context: RouteContext) {
      try {
        const id = (await context.params).id;
        const input = z.object({
          teacherGuidance: z.string().trim().max(1000).optional(),
          mode: z.enum(["full", "content_only"]).default("full"),
        }).parse(_request.headers.get("content-type")?.includes("application/json")
          ? await readJson(_request)
          : {});
        const review = dependencies.reviewService.get(dependencies.ownerId, id);
        if (review.images.length < 1 || review.images.length > MAX_REVIEW_IMAGES) {
          throw routeError(
            "IMAGES_REQUIRED",
            `请先上传 1 至 ${MAX_REVIEW_IMAGES} 张作文图片`,
            422,
          );
        }
        return ok(dependencies.analysisJobService.enqueue(
          dependencies.ownerId,
          id,
          input.teacherGuidance,
          input.mode,
        ), 202);
      } catch (error) {
        return failure(error);
      }
    },
    async GET_STATUS(_request: Request, context: RouteContext) {
      try {
        const id = (await context.params).id;
        dependencies.reviewService.get(dependencies.ownerId, id);
        return ok({ job: dependencies.analysisJobService.getForReview(dependencies.ownerId, id) });
      } catch (error) {
        return failure(error);
      }
    },
  };
}

export function createReviewFilesRouteHandlers(dependencies: {
  reviewService: Pick<ReviewService, "readImageFile">;
  ownerId: string;
}) {
  return {
    async GET(request: Request, context: RouteContext) {
      try {
        const params = new URL(request.url).searchParams;
        const rawImageId = params.get("imageId");
        const variant = params.get("variant");
        if (!rawImageId || !/^[1-9]\d*$/.test(rawImageId)) {
          throw routeError("INVALID_FILE_PATH", "图片 id 无效", 400);
        }
        if (!variant || !(reviewImageVariants as readonly string[]).includes(variant)) {
          throw routeError("INVALID_FILE_PATH", "图片版本无效", 400);
        }
        const file = await dependencies.reviewService.readImageFile(
          dependencies.ownerId,
          (await context.params).id,
          Number(rawImageId),
          variant as ReviewImageVariant,
        );
        const bytes = Uint8Array.from(file.data).buffer;
        return new Response(bytes, {
          status: 200,
          headers: {
            "content-type": file.contentType,
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff",
          },
        });
      } catch (error) {
        return failure(error);
      }
    },
  };
}

function rfc5987Filename(filename: string): string {
  return encodeURIComponent(filename).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function createReviewPdfRouteHandlers(dependencies: {
  pdfService: Pick<PdfService, "getOrCreate">;
  ownerId: string;
}) {
  return {
    async GET(_request: Request, context: RouteContext) {
      try {
        const result = await dependencies.pdfService.getOrCreate(
          dependencies.ownerId,
          (await context.params).id,
        );
        return new Response(Uint8Array.from(result.data).buffer, {
          status: 200,
          headers: {
            "content-type": "application/pdf",
            "content-disposition":
              `attachment; filename="composition-review.pdf"; ` +
              `filename*=UTF-8''${rfc5987Filename(result.filename)}`,
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff",
          },
        });
      } catch (error) {
        return failure(error);
      }
    },
  };
}

const batchPdfExportSchema = z.object({
  reviewIds: z.array(z.string().trim().min(1).max(128)).min(1).max(20),
}).strict().refine(
  ({ reviewIds }) => new Set(reviewIds).size === reviewIds.length,
  { message: "reviewIds must not contain duplicates" },
);

export function createBatchReviewPdfRouteHandlers(dependencies: {
  pdfBatchService: Pick<PdfBatchService, "exportBatch">;
  ownerId: string;
}) {
  return {
    async POST(request: Request) {
      try {
        const { reviewIds } = batchPdfExportSchema.parse(await readJson(request));
        const result = await dependencies.pdfBatchService.exportBatch(
          dependencies.ownerId,
          reviewIds,
        );
        return new Response(Uint8Array.from(result.data).buffer, {
          status: 200,
          headers: {
            "content-type": "application/zip",
            "content-disposition":
              `attachment; filename="review-pdfs.zip"; ` +
              `filename*=UTF-8''${rfc5987Filename(result.filename)}`,
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff",
          },
        });
      } catch (error) {
        return failure(error);
      }
    },
  };
}
