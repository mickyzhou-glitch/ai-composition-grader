import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";

import { openAppDatabase } from "../src/db/client.ts";
import { AuthRepository } from "../src/auth/auth-repository.ts";
import { AuthService, AuthServiceError } from "../src/auth/auth-service.ts";

type ParsedArgs = { command: string; flags: Record<string, string | boolean> };

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "", ...rest] = argv;
  const flags: Record<string, string | boolean> = Object.create(null) as Record<string, string | boolean>;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new Error("Invalid arguments");
    if (token === "--password" || token.startsWith("--password=")) {
      throw new Error("--password is not accepted");
    }
    const equals = token.indexOf("=");
    if (equals >= 0) {
      const key = token.slice(2, equals);
      const value = token.slice(equals + 1);
      if (!key || !value) throw new Error("Invalid arguments");
      flags[key] = value;
      continue;
    }
    const key = token.slice(2);
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return { command, flags };
}

function requiredFlag(flags: Record<string, string | boolean>, name: string): string {
  const value = flags[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing --${name}`);
  return value;
}

async function readHiddenPassword(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Password input requires an interactive terminal");
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  let echoDisabled = false;
  try {
    const result = spawnSync("stty", ["-echo"], { stdio: ["ignore", "ignore", "ignore"] });
    echoDisabled = result.status === 0;
    if (!echoDisabled) throw new Error("Unable to protect password input");
    return await readline.question("Password (hidden): ");
  } finally {
    if (echoDisabled) spawnSync("stty", ["echo"], { stdio: ["ignore", "ignore", "ignore"] });
    readline.close();
    process.stdout.write("\n");
  }
}

function printUsers(service: AuthService): void {
  for (const user of service.listUsers().sort((a, b) => a.username.localeCompare(b.username))) {
    const state = user.disabledAt ? "disabled" : "enabled";
    process.stdout.write(
      `${user.username}\t${user.role}\t${state}\tmustChangePassword=${user.mustChangePassword}\tcreatedAt=${user.createdAt.toISOString()}\tupdatedAt=${user.updatedAt.toISOString()}\n`,
    );
  }
}

async function run(argv: string[]): Promise<void> {
  const { command, flags } = parseArgs(argv);
  if (!command || (command !== "create" && command !== "reset-password" && command !== "disable" && command !== "enable" && command !== "revoke-sessions" && command !== "list")) {
    throw new Error("Usage: accounts <create|reset-password|disable|enable|revoke-sessions|list>");
  }
  const databasePath = path.resolve(process.env.APP_DATABASE_PATH ?? ".data/app.db");
  const opened = openAppDatabase(databasePath);
  try {
    const service = new AuthService(new AuthRepository(opened.db));
    if (command === "list") {
      printUsers(service);
      return;
    }
    const username = requiredFlag(flags, "username");
    if (command === "create") {
      const role = requiredFlag(flags, "role");
      const entered = await readHiddenPassword();
      const generatedPassword = entered.length === 0 ? randomBytes(24).toString("base64url") : null;
      const created = await service.createInvitedUser({
        username,
        role: role as "admin" | "teacher",
        password: entered.length > 0 ? entered : generatedPassword as string,
        mustChangePassword: true,
      });
      if (generatedPassword) {
        process.stdout.write(`Initial password (shown once): ${generatedPassword}\n`);
      } else {
        process.stdout.write("Account created. The user must change the password at first sign-in.\n");
      }
      process.stdout.write(`${created.username} created. The user must change the password at first sign-in.\n`);
      return;
    }
    const user = service.findUserByUsername(username);
    if (!user) throw new AuthServiceError("AUTH_NOT_FOUND", "Account was not found");
    if (command === "reset-password") {
      const password = await service.resetPassword(username);
      process.stdout.write(`Initial password (shown once): ${password}\n`);
      return;
    }
    if (command === "disable") {
      service.disableUser(user.id);
      process.stdout.write("Account disabled.\n");
      return;
    }
    if (command === "enable") {
      service.enableUser(user.id);
      process.stdout.write("Account enabled.\n");
      return;
    }
    service.revokeAllSessions(user.id);
    process.stdout.write("All sessions revoked.\n");
  } finally {
    opened.close();
  }
}

export { parseArgs, readHiddenPassword, run };

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  run(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof AuthServiceError ? error.message : error instanceof Error ? error.message : "Command failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
