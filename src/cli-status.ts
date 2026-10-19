import { spawn } from "node:child_process";
import type { DiscoveredCli } from "./discover-cli.js";
import { discoverOpencodeCli } from "./discover-cli.js";
import { detectInstallAdvice } from "./install-advice.js";
import type { InstallAdvice } from "./install-advice.js";
import type { HostFetchRoute } from "./model-settings.js";

/**
 * 「CLI 状态」数据面：给设置面板显示当前环境是否有 OpenCode CLI、在哪、什么版本，
 * 未安装时附安装建议（detectInstallAdvice，与 CLI_NOT_FOUND 报错同口径）。
 * 只读探测：发现复用 discover-cli 四级回退，版本走 `<exe> --version` 子进程，
 * 失败/超时一律降级成 versionError，绝不抛错影响面板。
 */

export interface CliStatusReport {
  /** 四级发现是否命中。 */
  found: boolean;
  /** 命中时的可执行文件绝对路径。 */
  command: string | null;
  /** 命中来源（discover-cli 的四级）。 */
  source: DiscoveredCli["source"] | null;
  /** 版本号（`--version` 首行解析）；探测失败为 null。 */
  version: string | null;
  /** 版本探测失败原因；成功为 null。 */
  versionError: string | null;
  /** 安装建议（恒在，面板未安装视图直接用）。 */
  install: InstallAdvice;
}

export interface CliStatusOptions {
  /** 显式绝对路径（同 discover-cli 的 opts.command）。 */
  command?: string;
  env?: Record<string, string | undefined>;
  /** 版本探测参数，默认 `["--version"]`。 */
  versionArgs?: readonly string[];
  /** 版本探测超时，默认 5000ms。 */
  versionTimeoutMs?: number;
}

export type VersionProbeResult =
  | { ok: true; version: string }
  | { ok: false; error: string };

function clip(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 版本输出首行 -> 版本号：`1.19.0` / `v24.18.1` / `opencode 1.19.0` 都收；解析不出退回首行原文。 */
export function parseVersionOutput(output: string): string | null {
  const line = output.split(/\r?\n/).map((s) => s.trim()).find((s) => s !== "");
  if (line === undefined) return null;
  const m = /(v?\d+(?:\.\d+){0,2}[\w.+-]*)/.exec(line);
  return m ? m[1] : clip(line, 80);
}

/**
 * spawn `<command> <args>` 取版本。任何失败（spawn 抛错、非零退出、超时、空输出）
 * 都收敛成 `{ok:false,error}`，调用方只做展示降级。
 */
export function probeVersion(
  command: string,
  options: { args?: readonly string[]; timeoutMs?: number } = {},
): Promise<VersionProbeResult> {
  const args = [...(options.args ?? ["--version"])];
  const timeoutMs = options.timeoutMs ?? 5000;
  return new Promise((resolvePromise) => {
    let settled = false;
    const done = (result: VersionProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      resolvePromise({ ok: false, error: clip(String(e)) });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += String(d); });
    child.stderr?.on("data", (d: Buffer) => { stderr += String(d); });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 杀不掉也不抛 */ }
      done({ ok: false, error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    child.on("error", (e) => done({ ok: false, error: clip(String(e)) }));
    child.on("close", (code) => {
      if (code !== 0) {
        done({ ok: false, error: clip(`exited with code ${code}${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`) });
        return;
      }
      const version = parseVersionOutput(stdout === "" ? stderr : stdout);
      if (version === null) {
        done({ ok: false, error: "empty version output" });
        return;
      }
      done({ ok: true, version });
    });
  });
}

/** 组装 CLI 状态报告；一切发现/探测失败都降级进字段，不抛错。 */
export async function checkCliStatus(options: CliStatusOptions = {}): Promise<CliStatusReport> {
  const install = detectInstallAdvice(options.env ?? process.env);
  let discovered: DiscoveredCli;
  try {
    discovered = await discoverOpencodeCli({ command: options.command, env: options.env });
  } catch {
    return { found: false, command: null, source: null, version: null, versionError: null, install };
  }
  const probed = await probeVersion(discovered.command, {
    args: options.versionArgs,
    timeoutMs: options.versionTimeoutMs,
  });
  return {
    found: true,
    command: discovered.command,
    source: discovered.source,
    version: probed.ok ? probed.version : null,
    versionError: probed.ok ? null : probed.error,
    install,
  };
}

/** client 可达的路由路径（同 model-settings 的 `/api/<segment>` 形态）。 */
export const CLI_STATUS_ROUTE_PATH = "/api/opencode-bridge.cli-status";

/** 构造 CLI 状态路由，供 plugin 注册进 `ctx.connection.fetch`（信封同 model-settings）。 */
export function buildCliStatusRoute(options: CliStatusOptions = {}): HostFetchRoute {
  return {
    path: CLI_STATUS_ROUTE_PATH,
    methods: ["GET", "POST"],
    requestBody: "buffered",
    fetch: async () => Response.json({ ok: true, value: await checkCliStatus(options) }),
  };
}
