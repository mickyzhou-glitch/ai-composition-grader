import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { MacOSKeychain } from "../src/settings/keychain.ts";

const NGROK_SERVICE = "ai-composition-grader-ngrok";
const NGROK_ACCOUNT = "tunnel-token";

/** Starts a tunnel without persisting its credential or exposing ngrok inspection. */
export async function runNgrok(): Promise<void> {
  const token = await new MacOSKeychain({ service: NGROK_SERVICE, account: NGROK_ACCOUNT }).get();
  if (!token) throw new Error("未在 macOS 钥匙串中找到 ngrok 隧道令牌");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ngrok", ["http", "http://127.0.0.1:3001", "--inspect=false"], {
      stdio: "inherit",
      // ngrok reads this in-process; the token is never written to disk or argv.
      env: { ...process.env, NGROK_AUTHTOKEN: token },
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("ngrok 隧道已停止")));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runNgrok().catch(() => { process.stderr.write("无法启动分享隧道\n"); process.exitCode = 1; });
}
