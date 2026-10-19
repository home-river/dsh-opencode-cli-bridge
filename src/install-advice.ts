import { statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

/**
 * 「CLI 未安装」时的安装建议（与 CLI 状态面板共用一套口径）。
 * 纯环境探测 + 常量，不 spawn 任何进程；discover-cli 的 CLI_NOT_FOUND
 * 文案也从这里取，保证报错与面板建议永远一致。
 */

export type PackageManager = "npm" | "scoop" | "choco" | "none";

export interface InstallAdvice {
  /** 推荐执行的安装命令（manager 为 none 时是 npm 兜底命令）。 */
  command: string;
  /** 推荐命令对应的包管理器；none = PATH 上什么都没探测到。 */
  manager: PackageManager;
  /** GitHub Releases 手动下载页。 */
  downloadUrl: string;
}

export const NPM_INSTALL_COMMAND = "npm i -g opencode-ai@latest";
export const DOWNLOAD_URL = "https://github.com/anomalyco/opencode/releases/latest";

const MANAGER_COMMANDS: Array<{ manager: Exclude<PackageManager, "none">; command: string; names: string[] }> = [
  { manager: "npm", command: NPM_INSTALL_COMMAND, names: ["npm.cmd", "npm.exe", "npm"] },
  { manager: "scoop", command: "scoop install opencode", names: ["scoop.cmd", "scoop.exe", "scoop"] },
  { manager: "choco", command: "choco install opencode", names: ["choco.exe", "choco.cmd", "choco"] },
];

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function hasOnPath(env: Record<string, string | undefined>, names: readonly string[]): boolean {
  const pathVar = env.PATH ?? env.Path ?? "";
  for (const dir of pathVar.split(delimiter).filter(Boolean)) {
    const base = isAbsolute(dir) ? dir : resolve(dir);
    for (const name of names) {
      if (isFile(join(base, name))) return true;
    }
  }
  return false;
}

/**
 * 按 npm > scoop > choco 优先级探测宿主 PATH 上的包管理器，产出安装建议；
 * 一个都没探测到时给 npm 兜底命令（manager:"none"，UI 配下载链接提示手动安装）。
 */
export function detectInstallAdvice(env: Record<string, string | undefined> = process.env): InstallAdvice {
  for (const candidate of MANAGER_COMMANDS) {
    if (hasOnPath(env, candidate.names)) {
      return { manager: candidate.manager, command: candidate.command, downloadUrl: DOWNLOAD_URL };
    }
  }
  return { manager: "none", command: NPM_INSTALL_COMMAND, downloadUrl: DOWNLOAD_URL };
}

/** CLI_NOT_FOUND 文案（discover-cli 与 DSH 失败消息共用）。 */
export function formatNotFoundMessage(advice: InstallAdvice = detectInstallAdvice()): string {
  return `OpenCode CLI not found. Install it with: ${advice.command} (or download from ${advice.downloadUrl})`;
}
