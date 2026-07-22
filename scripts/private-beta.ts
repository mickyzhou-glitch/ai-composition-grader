import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const labels = ["ai-composition-grader-web", "ai-composition-grader-worker", "ai-composition-grader-tunnel"] as const;
type Service = (typeof labels)[number];
const logs = join(root, ".data", "logs");
const agents = join(homedir(), "Library", "LaunchAgents");

function plist(label: Service, command: string[]): string {
  const output = join(logs, `${label}.log`);
  const error = join(logs, `${label}.error.log`);
  const program = command.map((value) => `<string>${value.replaceAll("&", "&amp;")}</string>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${program}</array><key>WorkingDirectory</key><string>${root}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${output}</string><key>StandardErrorPath</key><string>${error}</string></dict></plist>`;
}

async function install(): Promise<void> {
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  mkdirSync(agents, { recursive: true });
  const node = process.execPath;
  const services: Array<[Service, string[]]> = [
    [labels[0], [node, join(root, "node_modules", "next", "dist", "bin", "next"), "start", "--hostname", "127.0.0.1", "--port", "3001"]],
    [labels[1], [node, join(root, "node_modules", "tsx", "dist", "cli.mjs"), "scripts/worker.ts"]],
    [labels[2], [node, join(root, "node_modules", "tsx", "dist", "cli.mjs"), "scripts/ngrok.ts"]],
  ];
  for (const [label, command] of services) {
    const path = join(agents, `${label}.plist`);
    await writeFile(path, plist(label, command), { mode: 0o600 });
    await chmod(path, 0o600);
  }
  process.stdout.write("已安装本机服务配置。请先运行 npm run build，再用 start 启动网页与 Worker。\n");
}

function control(action: "bootstrap" | "bootout", service: Service): void {
  const path = join(agents, `${service}.plist`);
  const getuid = process.getuid;
  if (!getuid) throw new Error("此命令仅支持 macOS 本机用户会话");
  execFileSync("launchctl", [action, `gui/${getuid()}`, path], { stdio: "ignore" });
}

async function main(command: string, target?: string): Promise<void> {
  if (command === "install") return install();
  if (command === "start") { control("bootstrap", labels[0]); control("bootstrap", labels[1]); return; }
  if (command === "tunnel") { control("bootstrap", labels[2]); return; }
  if (command === "stop") { for (const item of labels) { try { control("bootout", item); } catch {} } return; }
  if (command === "status") { const getuid = process.getuid; if (!getuid) throw new Error("此命令仅支持 macOS"); spawn("launchctl", ["print", `gui/${getuid()}/${target ?? labels[0]}`], { stdio: "inherit" }); return; }
  if (command === "logs") { const service = (target === "worker" ? labels[1] : target === "tunnel" ? labels[2] : labels[0]); spawn("tail", ["-n", "100", "-f", join(logs, `${service}.log`)], { stdio: "inherit" }); return; }
  throw new Error("用法：npm run private-beta -- <install|start|tunnel|stop|status|logs> [web|worker|tunnel]");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv[2] ?? "", process.argv[3]).catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : "命令失败"}\n`); process.exitCode = 1; });
