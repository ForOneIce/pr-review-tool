/**
 * 统一启动 gh：避免 Windows 上固定用 Program Files 路径时偶发 ENOBUFS，且拉大 maxBuffer 防止大仓库 tree API 撑爆默认 1MB 缓冲。
 */
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const WIN_GH_DEFAULT = "C:\\Program Files\\GitHub CLI\\gh.exe";

function maxBufferBytes() {
  const mb = Number(process.env.GH_MAX_BUFFER_MB);
  const n = Number.isFinite(mb) && mb > 0 ? mb : 64;
  return Math.floor(n * 1024 * 1024);
}

/**
 * 解析要使用的 gh 可执行文件路径。
 * - 优先环境变量 GH_BINARY
 * - 否则用 PATH 中的 `gh`（与交互终端一致，通常更稳定）
 * - Windows 上仅当 `gh` 报 ENOENT 时再回退到 Program Files\GitHub CLI\gh.exe
 */
export function resolveGhBin() {
  const fromEnv = process.env.GH_BINARY?.trim();
  if (fromEnv) return fromEnv;
  return "gh";
}

/**
 * @param {string[]} args gh 参数（不含 gh 本身）
 * @param {string | null} [input] stdin
 * @returns {{ stdout: string, stderr: string, status: number | null, signal: string | null, error?: Error, ghBin: string }}
 */
export function spawnGh(args, input = null) {
  let ghBin = resolveGhBin();
  const opts = {
    input,
    encoding: "utf8",
    maxBuffer: maxBufferBytes(),
  };

  let result = spawnSync(ghBin, args, opts);

  if (result.error?.code === "ENOENT" && process.platform === "win32" && ghBin === "gh" && fs.existsSync(WIN_GH_DEFAULT)) {
    ghBin = WIN_GH_DEFAULT;
    result = spawnSync(ghBin, args, opts);
  }

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
    signal: result.signal,
    error: result.error,
    ghBin,
  };
}
