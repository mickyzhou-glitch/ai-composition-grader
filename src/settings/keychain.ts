import { execFile } from "node:child_process";

export const KEYCHAIN_SERVICE = "ai-composition-grader";
export const KEYCHAIN_ACCOUNT = "default";
const SECURITY_EXECUTABLE = "/usr/bin/security";

export interface KeychainRunnerResult {
  stdout: string;
  stderr?: string;
}

export type KeychainRunner = (
  executable: string,
  args: readonly string[],
  stdin?: string,
) => Promise<KeychainRunnerResult>;

const execFileRunner: KeychainRunner = (executable, args, stdin) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      [...args],
      { encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    if (stdin !== undefined) child.stdin?.end(stdin);
  });

export class MacOSKeychainUnavailableError extends Error {
  constructor(platform: NodeJS.Platform) {
    super(`macOS Keychain is unavailable on platform: ${platform}`);
    this.name = "MacOSKeychainUnavailableError";
  }
}

export class KeychainOperationError extends Error {
  constructor(operation: "set" | "get" | "delete") {
    super(`Unable to ${operation} the API key in macOS Keychain`);
    this.name = "KeychainOperationError";
  }
}

interface MacOSKeychainOptions {
  runner?: KeychainRunner;
  platform?: NodeJS.Platform;
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    Number(error.code) === 44
  );
}

export class MacOSKeychain {
  private readonly runner: KeychainRunner;
  private readonly platform: NodeJS.Platform;

  constructor(options: MacOSKeychainOptions = {}) {
    this.runner = options.runner ?? execFileRunner;
    this.platform = options.platform ?? process.platform;
  }

  async set(secret: string): Promise<void> {
    this.assertAvailable();
    if (secret.length === 0) throw new TypeError("API key must not be empty");
    try {
      await this.runner(SECURITY_EXECUTABLE, [
        "add-generic-password",
        "-U",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        KEYCHAIN_ACCOUNT,
        "-w",
        secret,
      ]);
    } catch {
      // Deliberately omit the original command error because it can contain -w <secret>.
      throw new KeychainOperationError("set");
    }
  }

  async get(): Promise<string | null> {
    this.assertAvailable();
    try {
      const { stdout } = await this.runner(SECURITY_EXECUTABLE, [
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        KEYCHAIN_ACCOUNT,
        "-w",
      ]);
      const secret = stdout.replace(/[\r\n]+$/, "");
      return secret.length > 0 ? secret : null;
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw new KeychainOperationError("get");
    }
  }

  async delete(): Promise<void> {
    this.assertAvailable();
    try {
      await this.runner(SECURITY_EXECUTABLE, [
        "delete-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        KEYCHAIN_ACCOUNT,
      ]);
    } catch (error) {
      if (isNotFoundError(error)) return;
      throw new KeychainOperationError("delete");
    }
  }

  private assertAvailable(): void {
    if (this.platform !== "darwin") {
      throw new MacOSKeychainUnavailableError(this.platform);
    }
  }
}
