import { readFileSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { CliBridgeError } from "./errors.js";

export interface DiscoverOptions {
  command?: string;
  env?: Record<string, string | undefined>;
}

export interface DiscoveredCli {
  command: string;
  source: "explicit" | "path" | "npm-global" | "shim-resolved";
}

const SHIM_EXTS = [".cmd", ".bat", ".ps1"];

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function looksLikeExe(p: string): boolean {
  return p.toLowerCase().endsWith(".exe") && isFile(p);
}

/**
 * 从 npm shim 文件内容里解析出真身 exe 的绝对路径。
 * npm 的 .cmd shim 末行形如：
 *   "%dp0%\node_modules\opencode-ai\bin\opencode.exe"   %*
 * 不是 shim（例如本身就是 .exe）时返回 null。
 *
 * G1/G2：命中 shim ≠ 使用 shim。.cmd 只能由 cmd.exe 解释，
 * 走它会被 %* 重新解析参数（可被命令注入），且取消时留孤儿进程。
 */
export function resolveShimTarget(shimPath: string): string | null {
  if (!isFile(shimPath)) return null;
  const lower = shimPath.toLowerCase();
  if (lower.endsWith(".exe")) return null;

  let content: string;
  try {
    content = readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }

  const m = /(?:\.{1,2}[\\/])*node_modules[\\/]opencode-ai[\\/]bin[\\/]opencode\.exe/i.exec(content);
  if (!m) return null;

  // 优先采用 shim 内容里匹配到的完整相对路径（可能含 ..\ 前缀，覆盖 npm 全局 shim 指向
  // lib/node_modules 的布局），再回落到 npm 标准布局，保持既有行为不变。
  const fromContent = resolve(dirname(shimPath), m[0].replace(/[\\/]/g, sep));
  if (isFile(fromContent)) return fromContent;

  const npmLayout = resolve(dirname(shimPath), "node_modules", "opencode-ai", "bin", "opencode.exe");
  return isFile(npmLayout) ? npmLayout : null;
}

function npmGlobalCandidate(env: Record<string, string | undefined>): string | null {
  const appData = env.APPDATA;
  if (appData) {
    const p = join(appData, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe");
    if (isFile(p)) return p;
  }
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const p = join(home, ".npm-global", "node_modules", "opencode-ai", "bin", "opencode.exe");
  return isFile(p) ? p : null;
}

/**
 * 四级回退（spec §9）：
 *   1. opts.command（显式绝对路径）
 *   2. PATH 上的 opencode（命中 .cmd/.bat/.ps1 shim 时解析出真身 exe）
 *   3. npm 全局 node_modules/opencode-ai/bin/opencode.exe
 *   4. 抛 CLI_NOT_FOUND
 */
export async function discoverOpencodeCli(opts: DiscoverOptions = {}): Promise<DiscoveredCli> {
  const env = opts.env ?? process.env;

  if (opts.command) {
    if (!isAbsolute(opts.command)) {
      throw new CliBridgeError(
        "CLI_NOT_FOUND",
        `explicit command must be an absolute path: ${opts.command}`,
      );
    }
    return { command: opts.command, source: "explicit" };
  }

  const pathVar = env.PATH ?? env.Path ?? "";
  const dirs = pathVar.split(delimiter).filter(Boolean);

  for (const dir of dirs) {
    const base = isAbsolute(dir) ? dir : resolve(dir);

    const exePath = join(base, "opencode.exe");
    if (looksLikeExe(exePath)) return { command: exePath, source: "path" };

    for (const ext of SHIM_EXTS) {
      const shimPath = join(base, `opencode${ext}`);
      if (!isFile(shimPath)) continue;
      const target = resolveShimTarget(shimPath);
      if (target) return { command: target, source: "shim-resolved" };
    }
  }

  const global = npmGlobalCandidate(env);
  if (global) return { command: global, source: "npm-global" };

  throw new CliBridgeError(
    "CLI_NOT_FOUND",
    "OpenCode CLI not found. Install it with: npm i -g opencode-ai",
  );
}
