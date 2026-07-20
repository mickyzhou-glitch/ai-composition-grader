import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
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

async function ensureRealDirectory(directory: string): Promise<void> {
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new UnsafeStoragePathError(directory);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
    await mkdir(directory);
    const created = await lstat(directory);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw new UnsafeStoragePathError(directory);
    }
  }
}

export class ReviewFileStore {
  readonly rootDirectory: string;

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
    await ensureRealDirectory(paths.reviewDirectory);
    await Promise.all([
      ensureRealDirectory(paths.imagesDirectory),
      ensureRealDirectory(paths.pdfDirectory),
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
    const file = await open(
      destination,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_TRUNC |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(data);
    } finally {
      await file.close();
    }
    return destination;
  }

  async readFile(
    reviewId: string,
    kind: ReviewStorageKind,
    filename: string,
  ): Promise<Buffer> {
    assertSafeSegment(filename);
    await this.assertSafeRoot(false);
    const paths = this.getReviewPaths(reviewId);
    const directory =
      kind === "images" ? paths.imagesDirectory : paths.pdfDirectory;
    const file = await open(
      resolveInside(directory, filename),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      return await file.readFile();
    } finally {
      await file.close();
    }
  }

  async deleteReview(reviewId: string): Promise<void> {
    if (!(await this.assertSafeRoot(false))) return;
    const { reviewDirectory } = this.getReviewPaths(reviewId);
    await rm(reviewDirectory, { recursive: true, force: true });
  }

  private async assertSafeRoot(create: boolean): Promise<boolean> {
    if (create) {
      await mkdir(path.dirname(this.rootDirectory), { recursive: true });
      await ensureRealDirectory(this.rootDirectory);
    }

    let rootInfo;
    try {
      rootInfo = await lstat(this.rootDirectory);
    } catch (error) {
      if (!create && isMissing(error)) return false;
      throw error;
    }
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new UnsafeStoragePathError(this.rootDirectory);
    }

    const [realRoot, realParent] = await Promise.all([
      realpath(this.rootDirectory),
      realpath(path.dirname(this.rootDirectory)),
    ]);
    if (
      path.dirname(realRoot) !== realParent ||
      path.basename(realRoot) !== path.basename(this.rootDirectory)
    ) {
      throw new UnsafeStoragePathError(this.rootDirectory);
    }
    return true;
  }
}
