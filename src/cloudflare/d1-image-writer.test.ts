// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { d1Shim, migratedDatabase } from "../../test/d1-sqlite-shim";
import { D1ImageWriter } from "./d1-image-writer";

const CONFIG = JSON.stringify({
  title: "我的老师",
  grade: "六年级",
  writingRequirements: "叙事",
  targetCharacters: 600,
  structureRequirements: "完整",
  scoringFocus: "细节",
  templateType: "custom",
});

describe("D1ImageWriter", () => {
  it("advances the image revision and clears OCR atomically when replacing images", async () => {
    const prepared: Array<{ sql: string }> = [];
    const prepare = vi.fn((sql: string) => {
      prepared.push({ sql });
      return {
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue(sql.includes("SELECT revision") ? { revision: 2 } : null),
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
          all: vi.fn().mockResolvedValue(
            sql.includes("original_path")
              ? { results: [{ original_path: "images/old.jpg", annotation_path: "images/old.jpg", ai_path: "images/old.jpg" }] }
              : { results: [{ id: 7, position: 0 }] },
          ),
        })),
      };
    });
    const batch = vi.fn().mockResolvedValue([{ meta: { changes: 1 } }]);
    const database = { prepare, batch } as unknown as D1Database;

    const result = await new D1ImageWriter(database).replace("owner-1", "review-1", 2, [{
      originalName: "essay.jpg",
      mimeType: "image/jpeg",
      width: 100,
      height: 200,
      path: "images/essay.jpg",
    }], true);

    expect(batch).toHaveBeenCalledOnce();
    expect(result).toEqual({
      images: [{ id: 7, position: 0 }],
      revision: 3,
      replacedPaths: ["images/old.jpg"],
    });
    const update = prepared.find(({ sql }) => sql.includes("UPDATE reviews SET"));
    expect(update?.sql).toContain("image_revision = image_revision + 1");
    expect(update?.sql).toContain("ocr_checkpoint = NULL");
    expect(update?.sql).toContain("report_ocr_revision = NULL");
    expect(update?.sql).toContain("teacher_reviewed_at = NULL");
    expect(update?.sql).not.toContain("expires_at");
  });

  it("returns previous paths and leaves existing rows untouched on revision conflict", async () => {
    const sqlite = migratedDatabase();
    try {
      const db = d1Shim(sqlite);
      sqlite.prepare("INSERT INTO users (id, username, password_hash, role, must_change_password, disabled_at, created_at, updated_at) VALUES ('owner-1', 'owner-1', 'hash', 'teacher', 0, NULL, 1, 1)").run();
      sqlite.prepare(`
        INSERT INTO reviews (id, owner_id, status, student_name, class_name, config, revision, image_revision, created_at, updated_at)
        VALUES ('review-1', 'owner-1', 'ready_for_review', '小明', '', ?, 2, 1, 100, 100)
      `).run(CONFIG);
      sqlite.prepare(`
        INSERT INTO review_images (review_id, page_index, path, position, original_name, mime_type, original_path, annotation_path, ai_path, width, height, rotation, created_at)
        VALUES ('review-1', 0, 'images/old-1.jpg', 0, 'old.jpg', 'image/jpeg', 'images/old-1.jpg', 'images/old-1.jpg', 'images/old-1.jpg', 100, 200, 0, 100)
      `).run();

      const writer = new D1ImageWriter(db);
      await expect(writer.replace("owner-1", "review-1", 1, [{
        originalName: "new.jpg",
        mimeType: "image/jpeg",
        width: 100,
        height: 200,
        path: "images/new-1.jpg",
      }], true)).rejects.toThrow("REVISION_CONFLICT");

      const beforeImages = sqlite.prepare("SELECT original_path FROM review_images WHERE review_id = 'review-1'").all() as Array<{ original_path: string }>;
      expect(beforeImages.map((row) => row.original_path)).toEqual(["images/old-1.jpg"]);

      const replaced = await writer.replace("owner-1", "review-1", 2, [{
        originalName: "new.jpg",
        mimeType: "image/jpeg",
        width: 120,
        height: 240,
        path: "images/new-1.jpg",
      }], true);
      expect(replaced.revision).toBe(3);
      expect(replaced.replacedPaths).toEqual(["images/old-1.jpg"]);
      expect(replaced.images).toHaveLength(1);

      const afterImages = sqlite.prepare("SELECT original_path FROM review_images WHERE review_id = 'review-1'").all() as Array<{ original_path: string }>;
      expect(afterImages.map((row) => row.original_path)).toEqual(["images/new-1.jpg"]);
    } finally {
      sqlite.close();
    }
  });

  it("cancels queued or running analysis jobs when images are replaced so new analysis can start", async () => {
    const sqlite = migratedDatabase();
    try {
      const db = d1Shim(sqlite);
      sqlite.prepare("INSERT INTO users (id, username, password_hash, role, must_change_password, disabled_at, created_at, updated_at) VALUES ('owner-1', 'owner-1', 'hash', 'teacher', 0, NULL, 1, 1)").run();
      sqlite.prepare(`
        INSERT INTO reviews (id, owner_id, status, student_name, class_name, config, revision, image_revision, analysis_run_id, created_at, updated_at)
        VALUES ('review-active', 'owner-1', 'analyzing', '小明', '', ?, 4, 1, 'job-old', 100, 100)
      `).run(CONFIG);
      sqlite.prepare(`
        INSERT INTO analysis_jobs (id, review_id, owner_id, mode, status, attempt, available_at, progress_stage, created_at)
        VALUES ('job-old', 'review-active', 'owner-1', 'full', 'running', 1, 100, 'reading_images', 100)
      `).run();

      const writer = new D1ImageWriter(db);
      await writer.replace("owner-1", "review-active", 4, [{
        originalName: "retake.jpg",
        mimeType: "image/jpeg",
        width: 800,
        height: 1200,
        path: "images/retake.jpg",
      }], true);

      const jobRow = sqlite.prepare("SELECT status, finished_at FROM analysis_jobs WHERE id = 'job-old'").get() as { status: string; finished_at: number | null };
      expect(jobRow.status).toBe("canceled");
      expect(jobRow.finished_at).not.toBeNull();
    } finally {
      sqlite.close();
    }
  });
});
