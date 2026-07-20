import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
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

  async deleteReview(reviewId: string): Promise<void> {
    const paths = this.getReviewPaths(reviewId);
    if (!(await this.assertSafeReviewPaths(paths))) return;
    await rm(paths.reviewDirectory, { recursive: true, force: true });
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
