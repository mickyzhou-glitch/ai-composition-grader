import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { MacOSKeychain } from "../src/settings/keychain.ts";
import {
  PDF_PRINT_TOKEN_KEYCHAIN_ACCOUNT,
  PDF_PRINT_TOKEN_KEYCHAIN_SERVICE,
} from "../src/pdf/print-token-secret.ts";

async function main(): Promise<void> {
  const secret = await new MacOSKeychain({
    service: PDF_PRINT_TOKEN_KEYCHAIN_SERVICE,
    account: PDF_PRINT_TOKEN_KEYCHAIN_ACCOUNT,
  }).get();
  if (!secret || secret.length < 32) {
    throw new Error("PDF 内部打印密钥未配置");
  }
  const root = resolve(import.meta.dirname, "..");
  const child = spawn(process.execPath, [
    join(root, "node_modules", "next", "dist", "bin", "next"),
    "start",
    "--hostname", "127.0.0.1",
    "--port", "3001",
  ], {
    stdio: "inherit",
    env: { ...process.env, PDF_PRINT_TOKEN_SECRET: secret },
  });
  await new Promise<void>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error("网页服务已停止")));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "网页服务无法启动"}\n`);
    process.exitCode = 1;
  });
}
