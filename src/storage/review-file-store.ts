import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";

export const DEFAULT_REVIEWS_DIRECTORY = path.resolve(
  process.cwd(),
  ".data/reviews",
);

export type ReviewStorageKind = "images" | "pdf";

export interface ReviewStoragePaths {
  reviewDirectory: string;
  imagesDirectory: string;
  pdfDirectory: string;
}

export interface StagedReviewDelete {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

interface CleanupQueueEntry {
  reviewId: string;
  filename: string;
}

const CLEANUP_QUEUE_FILENAME = ".cleanup-queue.json";
const STAGED_DELETE_PATTERN =
  /^(.*)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class UnsafeStoragePathError extends Error {
  constructor(segment: string) {
    super(`Unsafe storage path segment: ${JSON.stringify(segment)}`);
    this.name = "UnsafeStoragePathError";
  }
}

function assertSafeSegment(segment: string): void {
  if (
    segment.length === 0 ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    segment.includes("\0") ||
    path.isAbsolute(segment)
  ) {
    throw new UnsafeStoragePathError(segment);
  }
}

function resolveInside(parent: string, segment: string): string {
  assertSafeSegment(segment);
  const resolved = path.resolve(parent, segment);
  const relative = path.relative(parent, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new UnsafeStoragePathError(segment);
  }
  return resolved;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

async function assertRealDirectory(
  parent: string,
  directory: string,
): Promise<boolean> {
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new UnsafeStoragePathError(directory);
  }

  const [realDirectory, realParent] = await Promise.all([
    realpath(directory),
    realpath(parent),
  ]);
  if (
    path.dirname(realDirectory) !== realParent ||
    path.basename(realDirectory) !== path.basename(directory)
  ) {
    throw new UnsafeStoragePathError(directory);
  }
  return true;
}

async function ensureRealDirectory(
  parent: string,
  directory: string,
): Promise<void> {
  if (!(await assertRealDirectory(parent, directory))) {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    if (!(await assertRealDirectory(parent, directory))) {
      throw new UnsafeStoragePathError(directory);
    }
  }
}

async function assertSafeFile(parent: string, filename: string): Promise<void> {
  let info;
  try {
    info = await lstat(filename);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new UnsafeStoragePathError(filename);
  }

  const [realFile, realParent] = await Promise.all([
    realpath(filename),
    realpath(parent),
  ]);
  if (
    path.dirname(realFile) !== realParent ||
    path.basename(realFile) !== path.basename(filename)
  ) {
    throw new UnsafeStoragePathError(filename);
  }
}

function isSymlinkError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ELOOP"
  );
}

export class ReviewFileStore {
  readonly rootDirectory: string;
  private cleanupOperationQueue: Promise<void> = Promise.resolve();

  constructor(rootDirectory = DEFAULT_REVIEWS_DIRECTORY) {
    this.rootDirectory = path.resolve(rootDirectory);
  }

  getReviewPaths(reviewId: string): ReviewStoragePaths {
    const reviewDirectory = resolveInside(this.rootDirectory, reviewId);
    return {
      reviewDirectory,
      imagesDirectory: path.join(reviewDirectory, "images"),
      pdfDirectory: path.join(reviewDirectory, "pdf"),
    };
  }

  async createReview(reviewId: string): Promise<ReviewStoragePaths> {
    const paths = this.getReviewPaths(reviewId);
    await this.assertSafeRoot(true);
    await ensureRealDirectory(this.rootDirectory, paths.reviewDirectory);
    await Promise.all([
      ensureRealDirectory(paths.reviewDirectory, paths.imagesDirectory),
      ensureRealDirectory(paths.reviewDirectory, paths.pdfDirectory),
    ]);
    return paths;
  }

  async writeFile(
    reviewId: string,
    kind: ReviewStorageKind,
    filename: string,
    data: string | Uint8Array,
  ): Promise<string> {
    assertSafeSegment(filename);
    const paths = await this.createReview(reviewId);
    const directory =
      kind === "images" ? paths.imagesDirectory : paths.pdfDirectory;
    const destination = resolveInside(directory, filename);
    await assertSafeFile(directory, destination);
    await this.assertSafeReviewPaths(paths, kind);
    const temporary = resolveInside(directory, `.tmp-${randomUUID()}`);
    try {
      let file;
      try {
        file = await open(
          temporary,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
      } catch (error) {
        if (isSymlinkError(error)) {
          throw new UnsafeStoragePathError(destination);
        }
        throw error;
      }
      try {
        await file.writeFile(data);
        await file.sync();
      } finally {
        await file.close();
      }
      await this.assertSafeReviewPaths(paths, kind);
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    return destination;
  }

  async readFile(
    reviewId: string,
    kind: ReviewStorageKind,
    filename: string,
  ): Promise<Buffer> {
    assertSafeSegment(filename);
    const paths = this.getReviewPaths(reviewId);
    const directory =
      kind === "images" ? paths.imagesDirectory : paths.pdfDirectory;
    await this.assertSafeReviewPaths(paths, kind);
    const source = resolveInside(directory, filename);
    await assertSafeFile(directory, source);
    let file;
    try {
      file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isSymlinkError(error)) throw new UnsafeStoragePathError(source);
      throw error;
    }
    try {
      return await file.readFile();
    } finally {
      await file.close();
    }
  }

  async deleteFile(
    reviewId: string,
    kind: ReviewStorageKind,
    filename: string,
  ): Promise<void> {
    assertSafeSegment(filename);
    const paths = this.getReviewPaths(reviewId);
    const directory =
      kind === "images" ? paths.imagesDirectory : paths.pdfDirectory;
    if (!(await this.assertSafeReviewPaths(paths, kind))) return;
    const target = resolveInside(directory, filename);
    await assertSafeFile(directory, target);
    await rm(target, { force: true });
  }

  async queueImageCleanup(
    reviewId: string,
    filenames: string[],
  ): Promise<void> {
    assertSafeSegment(reviewId);
    filenames.forEach(assertSafeSegment);
    try {
      await this.enqueueCleanup(async () => {
        const existing = await this.readCleanupQueue();
        const unique = new Map(
          [...existing, ...filenames.map((filename) => ({ reviewId, filename }))]
            .map((entry) => [`${entry.reviewId}\0${entry.filename}`, entry]),
        );
        const queued = [...unique.values()];
        await this.writeCleanupQueue(queued);
        await this.retryImageCleanupExclusive(reviewId, queued);
      });
    } catch {
      // Old versions are unreferenced after the DB switch; cleanup is best-effort.
    }
  }

  async retryImageCleanup(reviewId: string): Promise<void> {
    assertSafeSegment(reviewId);
    try {
      await this.enqueueCleanup(async () => {
        await this.retryImageCleanupExclusive(
          reviewId,
          await this.readCleanupQueue(),
        );
      });
    } catch {
      // A persisted entry remains available for a later retry.
    }
  }

  async deleteReview(reviewId: string): Promise<void> {
    const paths = this.getReviewPaths(reviewId);
    if (!(await this.assertSafeReviewPaths(paths))) return;
    await rm(paths.reviewDirectory, { recursive: true, force: true });
  }

  async stageDelete(reviewId: string): Promise<StagedReviewDelete> {
    const paths = this.getReviewPaths(reviewId);
    if (!(await this.assertSafeReviewPaths(paths))) {
      return { commit: async () => {}, rollback: async () => {} };
    }
    const trashDirectory = path.join(this.rootDirectory, ".trash");
    await ensureRealDirectory(this.rootDirectory, trashDirectory);
    const stagedDirectory = resolveInside(
      trashDirectory,
      `${reviewId}-${randomUUID()}`,
    );
    await rename(paths.reviewDirectory, stagedDirectory);
    let state: "staged" | "committed" | "rolled_back" = "staged";
    return {
      commit: async () => {
        if (state !== "staged") return;
        await rm(stagedDirectory, { recursive: true, force: true });
        state = "committed";
      },
      rollback: async () => {
        if (state !== "staged") return;
        await this.assertSafeRoot(false);
        await assertRealDirectory(this.rootDirectory, trashDirectory);
        await assertRealDirectory(trashDirectory, stagedDirectory);
        try {
          await lstat(paths.reviewDirectory);
          throw new UnsafeStoragePathError(paths.reviewDirectory);
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        await rename(stagedDirectory, paths.reviewDirectory);
        state = "rolled_back";
      },
    };
  }

  async recoverStagedDeletes(
    reviewExists: (reviewId: string) => boolean | Promise<boolean>,
  ): Promise<void> {
    if (!(await this.assertSafeRoot(false))) return;
    const trashDirectory = resolveInside(this.rootDirectory, ".trash");
    if (!(await assertRealDirectory(this.rootDirectory, trashDirectory))) return;

    const entries = await readdir(trashDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const match = entry.name.match(STAGED_DELETE_PATTERN);
      const reviewId = match?.[1];
      if (!reviewId || !entry.isDirectory()) continue;
      assertSafeSegment(reviewId);
      const stagedDirectory = resolveInside(trashDirectory, entry.name);
      await assertRealDirectory(trashDirectory, stagedDirectory);
      if (!(await reviewExists(reviewId))) {
        await rm(stagedDirectory, { recursive: true, force: true });
        continue;
      }

      const reviewDirectory = this.getReviewPaths(reviewId).reviewDirectory;
      try {
        await lstat(reviewDirectory);
        continue;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      await rename(stagedDirectory, reviewDirectory);
    }
  }

  private enqueueCleanup(operation: () => Promise<void>): Promise<void> {
    const result = this.cleanupOperationQueue.then(operation, operation);
    this.cleanupOperationQueue = result.catch(() => undefined);
    return result;
  }

  private async retryImageCleanupExclusive(
    reviewId: string,
    queued: CleanupQueueEntry[],
  ): Promise<void> {
    const remaining: CleanupQueueEntry[] = [];
    for (const entry of queued) {
      if (entry.reviewId !== reviewId) {
        remaining.push(entry);
        continue;
      }
      try {
        await this.deleteFile(entry.reviewId, "images", entry.filename);
      } catch {
        remaining.push(entry);
      }
    }
    await this.writeCleanupQueue(remaining);
  }

  private async readCleanupQueue(): Promise<CleanupQueueEntry[]> {
    if (!(await this.assertSafeRoot(false))) return [];
    const queuePath = resolveInside(
      this.rootDirectory,
      CLEANUP_QUEUE_FILENAME,
    );
    await assertSafeFile(this.rootDirectory, queuePath);
    let serialized: string;
    try {
      serialized = await readFile(queuePath, "utf8");
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const parsed: unknown = JSON.parse(serialized);
    if (!Array.isArray(parsed)) throw new TypeError("cleanup queue is invalid");
    return parsed.map((entry) => {
      if (
        typeof entry !== "object" ||
        entry === null ||
        !("reviewId" in entry) ||
        typeof entry.reviewId !== "string" ||
        !("filename" in entry) ||
        typeof entry.filename !== "string"
      ) {
        throw new TypeError("cleanup queue is invalid");
      }
      assertSafeSegment(entry.reviewId);
      assertSafeSegment(entry.filename);
      return { reviewId: entry.reviewId, filename: entry.filename };
    });
  }

  private async writeCleanupQueue(entries: CleanupQueueEntry[]): Promise<void> {
    const queuePath = resolveInside(
      this.rootDirectory,
      CLEANUP_QUEUE_FILENAME,
    );
    if (entries.length === 0) {
      if (!(await this.assertSafeRoot(false))) return;
      await assertSafeFile(this.rootDirectory, queuePath);
      await rm(queuePath, { force: true });
      return;
    }

    await this.assertSafeRoot(true);
    await assertSafeFile(this.rootDirectory, queuePath);
    const temporary = resolveInside(
      this.rootDirectory,
      `.tmp-cleanup-${randomUUID()}`,
    );
    try {
      const file = await open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(JSON.stringify(entries));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, queuePath);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  private async assertSafeRoot(create: boolean): Promise<boolean> {
    if (create) {
      await mkdir(path.dirname(this.rootDirectory), { recursive: true });
      await ensureRealDirectory(path.dirname(this.rootDirectory), this.rootDirectory);
      await chmod(this.rootDirectory, 0o700);
    }
    return assertRealDirectory(path.dirname(this.rootDirectory), this.rootDirectory);
  }

  private async assertSafeReviewPaths(
    paths: ReviewStoragePaths,
    kind?: ReviewStorageKind,
  ): Promise<boolean> {
    if (!(await this.assertSafeRoot(false))) return false;
    if (!(await assertRealDirectory(this.rootDirectory, paths.reviewDirectory))) {
      return false;
    }
    if (kind) {
      const directory =
        kind === "images" ? paths.imagesDirectory : paths.pdfDirectory;
      if (!(await assertRealDirectory(paths.reviewDirectory, directory))) {
        return false;
      }
    }
    return true;
  }
}
