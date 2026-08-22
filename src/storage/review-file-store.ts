import { createHash, randomUUID } from "node:crypto";
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
  rmdir,
  rm,
  utimes,
} from "node:fs/promises";
import path from "node:path";

export const DEFAULT_USERS_DIRECTORY = path.resolve(
  process.cwd(),
  ".data/users",
);
export const DEFAULT_LEGACY_REVIEWS_DIRECTORY = path.resolve(
  process.cwd(),
  ".data/reviews",
);

export type ReviewStorageKind = "images" | "pdf";

export interface ReviewStoragePaths {
  reviewDirectory: string;
  imagesDirectory: string;
  pdfDirectory: string;
}

export interface ReviewFileStoreOptions {
  lockWaitMs?: number;
  lockRetryMs?: number;
}

export interface StagedReviewDelete {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

interface CleanupQueueEntry {
  ownerId: string;
  reviewId: string;
  kind: ReviewStorageKind;
  filename: string;
}

const CLEANUP_QUEUE_FILENAME = ".cleanup-queue.json";
const REVIEW_LOCKS_DIRECTORY = ".review-locks";
const REVIEW_LOCK_WAIT_MS = 10_000;
const REVIEW_LOCK_RETRY_MS = 25;
// PDF rendering has a 60 second upper bound. Five minutes leaves a wide
// margin for normal work while making a lock left by a crashed process recover.
const REVIEW_LOCK_STALE_MS = 5 * 60 * 1000;
const REVIEW_LOCK_HEARTBEAT_MS = 30 * 1000;
const STAGED_DELETE_PATTERN =
  /^(.*)--(.*)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class UnsafeStoragePathError extends Error {
  constructor(segment: string) {
    super(`Unsafe storage path segment: ${JSON.stringify(segment)}`);
    this.name = "UnsafeStoragePathError";
  }
}

export class ReviewFileLockBusyError extends Error {
  readonly code = "REVIEW_LOCK_BUSY";
  readonly status = 409;

  constructor() {
    super("作文正在由另一项操作处理，请稍后重试");
    this.name = "ReviewFileLockBusyError";
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

  let realDirectory: string;
  let realParent: string;
  try {
    [realDirectory, realParent] = await Promise.all([
      realpath(directory),
      realpath(parent),
    ]);
  } catch (error) {
    // Another process can atomically reclaim a stale lease between lstat and
    // realpath. Treat that as absent so the caller retries acquisition.
    if (isMissing(error)) return false;
    throw error;
  }
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

async function reclaimStaleReviewLock(
  parent: string,
  lockDirectory: string,
): Promise<boolean> {
  let info;
  try {
    info = await lstat(lockDirectory);
  } catch (error) {
    if (isMissing(error)) return true;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new UnsafeStoragePathError(lockDirectory);
  }
  if (Date.now() - info.mtimeMs <= REVIEW_LOCK_STALE_MS) return false;

  // A stale timestamp alone is not authority to steal a lock: a suspended or
  // busy process could still own it. Only an explicitly dead owner PID may be
  // reclaimed; live, protected, or malformed owners remain safely busy.
  let owner: ReviewLockOwner | null;
  try {
    if (!(await assertRealDirectory(parent, lockDirectory))) return true;
    const ownerFile = resolveInside(lockDirectory, "owner.json");
    await assertSafeFile(lockDirectory, ownerFile);
    owner = parseReviewLockOwner(await readFile(ownerFile, "utf8"));
  } catch (error) {
    if (isMissing(error)) {
      // A competing reclaimer may have renamed the directory. If it is still
      // present, however, this is a crash between mkdir and owner.json and must
      // remain safely busy rather than spinning forever on EEXIST.
      return !(await assertRealDirectory(parent, lockDirectory));
    }
    throw error;
  }
  if (!owner || !isDefinitelyDeadProcess(owner.pid)) return false;
  const tombstone = resolveInside(
    parent,
    `${path.basename(lockDirectory)}.tombstone-${randomUUID()}`,
  );
  try {
    // Atomic rename is the recovery claim. At most one reclaimer can move the
    // fixed directory; contenders see ENOENT and retry acquisition normally.
    await rename(lockDirectory, tombstone);
    await rm(tombstone, { recursive: true, force: true }).catch(() => undefined);
    return true;
  } catch (error) {
    if (isMissing(error)) return true;
    throw error;
  }
}

interface ReviewLockOwner {
  pid: number;
  nonce: string;
}

function parseReviewLockOwner(value: string): ReviewLockOwner | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Object.hasOwn(parsed, "pid") ||
      !Object.hasOwn(parsed, "nonce")
    ) {
      return null;
    }
    const { pid, nonce } = parsed as { pid: unknown; nonce: unknown };
    if (
      typeof pid !== "number" ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      typeof nonce !== "string" ||
      nonce.length < 16
    ) {
      return null;
    }
    return { pid, nonce };
  } catch {
    return null;
  }
}

function isDefinitelyDeadProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

function sameFileIdentity(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
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
  readonly legacyRootDirectory: string;
  private cleanupOperationQueue: Promise<void> = Promise.resolve();
  private readonly lockWaitMs: number;
  private readonly lockRetryMs: number;

  constructor(
    rootDirectory = DEFAULT_USERS_DIRECTORY,
    legacyRootDirectory = DEFAULT_LEGACY_REVIEWS_DIRECTORY,
    options: ReviewFileStoreOptions = {},
  ) {
    this.rootDirectory = path.resolve(rootDirectory);
    this.legacyRootDirectory = path.resolve(legacyRootDirectory);
    this.lockWaitMs = options.lockWaitMs ?? REVIEW_LOCK_WAIT_MS;
    this.lockRetryMs = options.lockRetryMs ?? REVIEW_LOCK_RETRY_MS;
    if (!Number.isInteger(this.lockWaitMs) || this.lockWaitMs < 1) {
      throw new TypeError("lockWaitMs must be a positive integer");
    }
    if (!Number.isInteger(this.lockRetryMs) || this.lockRetryMs < 1) {
      throw new TypeError("lockRetryMs must be a positive integer");
    }
  }

  getReviewPaths(ownerId: string, reviewId: string): ReviewStoragePaths {
    const ownerDirectory = resolveInside(this.rootDirectory, ownerId);
    const reviewsDirectory = path.join(ownerDirectory, "reviews");
    const reviewDirectory = resolveInside(reviewsDirectory, reviewId);
    return {
      reviewDirectory,
      imagesDirectory: path.join(reviewDirectory, "images"),
      pdfDirectory: path.join(reviewDirectory, "pdf"),
    };
  }

  /**
   * Cross-process lock for one exact owner/review pair. The filesystem is the
   * shared coordination point between the web process and retention CLI; the
   * caller must re-read the database only after this lock is held.
   */
  async withReviewLock<T>(
    ownerId: string,
    reviewId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    assertSafeSegment(ownerId);
    assertSafeSegment(reviewId);
    const lockName = createHash("sha256").update(`${ownerId}\0${reviewId}`).digest("hex");
    return this.withFilesystemLock(lockName, operation);
  }

  private async withCleanupQueueLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockName = createHash("sha256").update("cleanup-queue\0v1").digest("hex");
    return this.withFilesystemLock(lockName, operation);
  }

  private async withFilesystemLock<T>(
    lockName: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    await this.assertSafeRoot(true);
    const locksDirectory = path.join(this.rootDirectory, REVIEW_LOCKS_DIRECTORY);
    await ensureRealDirectory(this.rootDirectory, locksDirectory);
    const lockDirectory = resolveInside(locksDirectory, lockName);
    const deadline = Date.now() + this.lockWaitMs;

    while (true) {
      try {
        await mkdir(lockDirectory, { mode: 0o700 });
        break;
      } catch (error) {
        if (isSymlinkError(error)) throw new UnsafeStoragePathError(lockDirectory);
        if (!isAlreadyExists(error)) throw error;
        await assertRealDirectory(locksDirectory, lockDirectory);
        if (await reclaimStaleReviewLock(locksDirectory, lockDirectory)) continue;
        if (Date.now() >= deadline) throw new ReviewFileLockBusyError();
        await new Promise<void>((resolve) => setTimeout(resolve, this.lockRetryMs));
      }
    }

    const ownerNonce = randomUUID();
    const ownerMarker = JSON.stringify({ pid: process.pid, nonce: ownerNonce });
    const ownerFile = resolveInside(lockDirectory, "owner.json");
    let ownerHandle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      ownerHandle = await open(
        ownerFile,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      await ownerHandle.writeFile(ownerMarker, { encoding: "utf8" });
      await ownerHandle.sync();
    } catch (error) {
      await rm(lockDirectory, { recursive: true, force: true });
      throw error;
    } finally {
      await ownerHandle?.close();
    }
    const lockIdentity = await lstat(lockDirectory);
    const heartbeat = setInterval(() => {
      void this.refreshReviewLockHeartbeat(lockDirectory, lockIdentity);
    }, REVIEW_LOCK_HEARTBEAT_MS);

    try {
      return await operation();
    } finally {
      clearInterval(heartbeat);
      await this.releaseOwnedReviewLock(
        locksDirectory,
        lockDirectory,
        lockIdentity,
        ownerMarker,
      );
    }
  }

  private async refreshReviewLockHeartbeat(
    lockDirectory: string,
    identity: { dev: number; ino: number },
  ): Promise<void> {
    try {
      const current = await lstat(lockDirectory);
      if (!current.isDirectory() || current.isSymbolicLink() || !sameFileIdentity(current, identity)) {
        return;
      }
      const now = new Date();
      await utimes(lockDirectory, now, now);
    } catch {
      // The operation will still safely re-check the database before writing;
      // a lost heartbeat only makes a later stale recovery possible.
    }
  }

  private async releaseOwnedReviewLock(
    parent: string,
    lockDirectory: string,
    identity: { dev: number; ino: number },
    ownerMarker: string,
  ): Promise<void> {
    try {
      const current = await lstat(lockDirectory);
      if (!current.isDirectory() || current.isSymbolicLink() || !sameFileIdentity(current, identity)) {
        return;
      }
      await assertRealDirectory(parent, lockDirectory);
      const ownerFile = resolveInside(lockDirectory, "owner.json");
      await assertSafeFile(lockDirectory, ownerFile);
      const contents = await readFile(ownerFile, "utf8");
      if (contents !== ownerMarker) return;
      await rm(ownerFile, { force: false });
      await rmdir(lockDirectory);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  async createReview(ownerId: string, reviewId: string): Promise<ReviewStoragePaths> {
    const paths = this.getReviewPaths(ownerId, reviewId);
    await this.assertSafeRoot(true);
    const ownerDirectory = path.dirname(path.dirname(paths.reviewDirectory));
    const reviewsDirectory = path.dirname(paths.reviewDirectory);
    await ensureRealDirectory(this.rootDirectory, ownerDirectory);
    await ensureRealDirectory(ownerDirectory, reviewsDirectory);
    await ensureRealDirectory(reviewsDirectory, paths.reviewDirectory);
    await Promise.all([
      ensureRealDirectory(paths.reviewDirectory, paths.imagesDirectory),
      ensureRealDirectory(paths.reviewDirectory, paths.pdfDirectory),
    ]);
    return paths;
  }

  /**
   * Move a legacy review directory only after the caller has checked the
   * database owner. The destination wins when both copies exist, making the
   * operation idempotent and preventing a stale legacy tree from overwriting
   * newer tenant-scoped files.
   */
  async migrateLegacyReview(ownerId: string, reviewId: string): Promise<void> {
    assertSafeSegment(ownerId);
    assertSafeSegment(reviewId);
    await this.assertSafeRoot(true);
    const legacyRoot = this.legacyRootDirectory;
    await ensureRealDirectory(path.dirname(legacyRoot), legacyRoot).catch((error) => {
      if (!isMissing(error)) throw error;
    });
    const legacyReview = resolveInside(legacyRoot, reviewId);
    let legacyExists = false;
    try {
      legacyExists = await assertRealDirectory(legacyRoot, legacyReview);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (!legacyExists) return;

    const destination = this.getReviewPaths(ownerId, reviewId).reviewDirectory;
    const ownerDirectory = path.dirname(path.dirname(destination));
    const reviewsDirectory = path.dirname(destination);
    await ensureRealDirectory(this.rootDirectory, ownerDirectory);
    await ensureRealDirectory(ownerDirectory, reviewsDirectory);
    let destinationExists = false;
    try {
      destinationExists = await assertRealDirectory(reviewsDirectory, destination);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (destinationExists) {
      await rm(legacyReview, { recursive: true, force: true });
      return;
    }
    try {
      await rename(legacyReview, destination);
    } catch (error) {
      // Two requests may race after both observed the legacy directory. If
      // the first request won the rename, the destination is authoritative.
      if (isMissing(error)) {
        try {
          if (await assertRealDirectory(reviewsDirectory, destination)) return;
        } catch (destinationError) {
          if (!isMissing(destinationError)) throw destinationError;
        }
      }
      throw error;
    }
  }

  async writeFile(
    ownerId: string,
    reviewId: string,
    kind: ReviewStorageKind,
    filename: string,
    data: string | Uint8Array,
  ): Promise<string> {
    assertSafeSegment(filename);
    const paths = await this.createReview(ownerId, reviewId);
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
    ownerId: string,
    reviewId: string,
    kind: ReviewStorageKind,
    filename: string,
  ): Promise<Buffer> {
    assertSafeSegment(filename);
    const paths = this.getReviewPaths(ownerId, reviewId);
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
    ownerId: string,
    reviewId: string,
    kind: ReviewStorageKind,
    filename: string,
  ): Promise<void> {
    assertSafeSegment(filename);
    const paths = this.getReviewPaths(ownerId, reviewId);
    const directory =
      kind === "images" ? paths.imagesDirectory : paths.pdfDirectory;
    if (!(await this.assertSafeReviewPaths(paths, kind))) return;
    const target = resolveInside(directory, filename);
    await assertSafeFile(directory, target);
    await rm(target, { force: true });
  }

  async queueImageCleanup(ownerId: string, reviewId: string, filenames: string[]): Promise<void> {
    await this.queueFileCleanup(ownerId, reviewId, "images", filenames);
  }

  async queuePdfCleanup(ownerId: string, reviewId: string, filenames: string[]): Promise<void> {
    await this.queueFileCleanup(ownerId, reviewId, "pdf", filenames, true);
  }

  async queuePdfCleanupDurably(ownerId: string, reviewId: string, filenames: string[]): Promise<void> {
    await this.queueFileCleanup(ownerId, reviewId, "pdf", filenames, false);
  }

  private async queueFileCleanup(
    ownerId: string,
    reviewId: string,
    kind: ReviewStorageKind,
    filenames: string[],
    bestEffort = true,
  ): Promise<void> {
    assertSafeSegment(ownerId);
    assertSafeSegment(reviewId);
    filenames.forEach(assertSafeSegment);
    const operation = this.enqueueCleanup(() => this.withCleanupQueueLock(async () => {
      const existing = await this.readCleanupQueue();
      const unique = new Map(
        [
          ...existing,
          ...filenames.map((filename) => ({ ownerId, reviewId, kind, filename })),
        ].map((entry) => [
          `${entry.ownerId}\0${entry.reviewId}\0${entry.kind}\0${entry.filename}`,
          entry,
        ]),
      );
      const queued = [...unique.values()];
      await this.writeCleanupQueue(queued);
      await this.retryFileCleanupExclusive(ownerId, reviewId, queued);
    }));
    if (!bestEffort) return operation;
    try {
      await operation;
    } catch {
      // Old versions are unreferenced after the DB switch; cleanup is best-effort.
    }
  }

  async retryImageCleanup(ownerId: string, reviewId: string): Promise<void> {
    assertSafeSegment(ownerId);
    assertSafeSegment(reviewId);
    try {
      await this.enqueueCleanup(() => this.withCleanupQueueLock(async () => {
        await this.retryFileCleanupExclusive(
          ownerId,
          reviewId,
          await this.readCleanupQueue(),
        );
      }));
    } catch {
      // A persisted entry remains available for a later retry.
    }
  }

  async deleteReview(ownerId: string, reviewId: string): Promise<void> {
    const paths = this.getReviewPaths(ownerId, reviewId);
    if (!(await this.assertSafeReviewPaths(paths))) return;
    await rm(paths.reviewDirectory, { recursive: true, force: true });
  }

  async stageDelete(ownerId: string, reviewId: string): Promise<StagedReviewDelete> {
    const paths = this.getReviewPaths(ownerId, reviewId);
    if (!(await this.assertSafeReviewPaths(paths))) {
      return { commit: async () => {}, rollback: async () => {} };
    }
    const trashDirectory = path.join(this.rootDirectory, ".trash");
    await ensureRealDirectory(this.rootDirectory, trashDirectory);
    const stagedDirectory = resolveInside(
      trashDirectory,
      `${ownerId}--${reviewId}-${randomUUID()}`,
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
    reviewExists: (ownerId: string, reviewId: string) => boolean | Promise<boolean>,
  ): Promise<void> {
    if (!(await this.assertSafeRoot(false))) return;
    const trashDirectory = resolveInside(this.rootDirectory, ".trash");
    if (!(await assertRealDirectory(this.rootDirectory, trashDirectory))) return;

    const entries = await readdir(trashDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const match = entry.name.match(STAGED_DELETE_PATTERN);
      const ownerId = match?.[1];
      const reviewId = match?.[2];
      if (!ownerId || !reviewId || !entry.isDirectory()) continue;
      assertSafeSegment(ownerId);
      assertSafeSegment(reviewId);
      const stagedDirectory = resolveInside(trashDirectory, entry.name);
      await assertRealDirectory(trashDirectory, stagedDirectory);
      if (!(await reviewExists(ownerId, reviewId))) {
        await rm(stagedDirectory, { recursive: true, force: true });
        continue;
      }

      const reviewDirectory = this.getReviewPaths(ownerId, reviewId).reviewDirectory;
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

  private async retryFileCleanupExclusive(
    ownerId: string,
    reviewId: string,
    queued: CleanupQueueEntry[],
  ): Promise<void> {
    const remaining: CleanupQueueEntry[] = [];
    for (const entry of queued) {
      if (entry.ownerId !== ownerId || entry.reviewId !== reviewId) {
        remaining.push(entry);
        continue;
      }
      try {
        await this.deleteFile(entry.ownerId, entry.reviewId, entry.kind, entry.filename);
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
        !("ownerId" in entry) ||
        typeof entry.ownerId !== "string" ||
        !("reviewId" in entry) ||
        typeof entry.reviewId !== "string" ||
        !("filename" in entry) ||
        typeof entry.filename !== "string"
      ) {
        throw new TypeError("cleanup queue is invalid");
      }
      assertSafeSegment(entry.ownerId);
      assertSafeSegment(entry.reviewId);
      assertSafeSegment(entry.filename);
      const kind =
        "kind" in entry && (entry.kind === "images" || entry.kind === "pdf")
          ? entry.kind
          : "images";
      return { ownerId: entry.ownerId, reviewId: entry.reviewId, kind, filename: entry.filename };
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
    const ownerDirectory = path.dirname(path.dirname(paths.reviewDirectory));
    const reviewsDirectory = path.dirname(paths.reviewDirectory);
    if (!(await assertRealDirectory(this.rootDirectory, ownerDirectory))) {
      return false;
    }
    if (!(await assertRealDirectory(ownerDirectory, reviewsDirectory))) {
      return false;
    }
    if (!(await assertRealDirectory(reviewsDirectory, paths.reviewDirectory))) {
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
