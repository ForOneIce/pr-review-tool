/** 将 gh / GitHub API 失败时的 stdout/stderr 压成命令行可读摘要（避免整段 JSON 刷屏） */

const BODY_SUMMARY_MAX = 700;

function truncate(s, max = BODY_SUMMARY_MAX) {
  const t = String(s || "").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…（已截断，共 ${t.length} 字符）`;
}

function summarizeGithubApiJsonText(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === "object" && !Array.isArray(j)) {
      const parts = [];
      if (j.message) parts.push(String(j.message));
      if (Array.isArray(j.errors) && j.errors.length > 0) {
        for (const e of j.errors.slice(0, 3)) {
          const line =
            typeof e === "string"
              ? e
              : [e.resource, e.field, e.code, e.message].filter(Boolean).join(" ") || JSON.stringify(e);
          if (line) parts.push(line);
        }
      }
      if (j.documentation_url) parts.push(`文档: ${j.documentation_url}`);
      if (parts.length > 0) return truncate(parts.join(" | "), BODY_SUMMARY_MAX);
    }
  } catch {
    /* 非 JSON */
  }
  return truncate(raw);
}

/**
 * @param {string} stderr
 * @param {string} stdout
 * @returns {string}
 */
export function formatGhFailureMessage(stderr, stdout) {
  const eOut = summarizeGithubApiJsonText(stdout);
  const eErr = summarizeGithubApiJsonText(stderr);
  const s = String(stderr || "").trim();
  const sShort = s.length > 400 ? `${s.slice(0, 400)}…` : s;

  if (eOut && sShort && eErr !== eOut && !sShort.includes(String(eOut).slice(0, 30))) {
    return `${sShort} | ${eOut}`;
  }
  if (eOut) return eOut;
  if (eErr) return eErr;
  if (sShort) return sShort;
  const o = String(stdout || "").trim();
  const fallback = o ? truncate(o) : "unknown error";
  return fallback.trim() || "无 stderr/stdout 输出";
}

/**
 * gh 进程非 0 退出时抛出带摘要的 Error；设置 DEBUG_GH=1 时在 error 上附带原始输出供 logGhFatalError 打印。
 * @param {string} stderr
 * @param {string} stdout
 * @param {{ exitCode?: number | null, signal?: string | null, ghBin?: string, ghArgs?: string[] }} [extra]
 */
export function throwOnGhFailure(stderr, stdout, extra = {}) {
  let summary = formatGhFailureMessage(stderr, stdout);
  const { exitCode, signal, ghBin, ghArgs } = extra;
  const bits = [];
  if (exitCode !== undefined && exitCode !== null) bits.push(`退出码=${exitCode}`);
  if (signal) bits.push(`signal=${signal}`);
  const metaSuffix = bits.length ? `（${bits.join(", ")}）` : "";

  const noStreams = !String(stderr || "").trim() && !String(stdout || "").trim();
  if (noStreams || summary === "unknown error" || summary === "无 stderr/stdout 输出") {
    summary = `${summary}${metaSuffix}`;
    if (ghBin) summary += ` 使用的 gh: ${ghBin}`;
    if (noStreams && ghBin && process.platform === "win32") {
      summary +=
        " | 若终端里 `gh api user` 正常但脚本失败，多半是 PATH 里的 gh 与上述路径不是同一个安装，请在两边分别执行 `gh --version` 对比。";
    }
  } else if (metaSuffix) {
    summary = `${summary} ${metaSuffix}`;
  }

  if (ghArgs?.length && process.env.DEBUG_GH === "1") {
    summary += ` | args: ${ghArgs.slice(0, 6).join(" ")}${ghArgs.length > 6 ? " …" : ""}`;
  }

  const err = new Error(`gh 命令失败: ${summary}`);
  if (process.env.DEBUG_GH === "1") {
    err.ghDebugStdout = stdout;
    err.ghDebugStderr = stderr;
    err.ghDebugArgs = ghArgs;
    err.ghDebugBin = ghBin;
  }
  throw err;
}

/** 在 main().catch 中打印错误；若为 gh 失败且未开 DEBUG_GH，提示如何查看完整输出 */
export function logGhFatalError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  if (err instanceof Error && err.ghDebugStdout != null) {
    if (err.ghDebugBin) console.error(`\n--- DEBUG_GH gh 路径: ${err.ghDebugBin} ---`);
    if (err.ghDebugArgs?.length) console.error(`--- DEBUG_GH args: ${err.ghDebugArgs.join(" ")} ---`);
    console.error("\n--- DEBUG_GH 原始 stdout（最多 6000 字符）---");
    console.error(String(err.ghDebugStdout).slice(0, 6000));
    if (err.ghDebugStderr) {
      console.error("\n--- DEBUG_GH stderr ---");
      console.error(String(err.ghDebugStderr).slice(0, 3000));
    }
  } else if (err instanceof Error && msg.includes("gh 命令失败")) {
    console.error(
      "提示: 需要查看 gh 完整输出时，可先执行 $env:DEBUG_GH=\"1\"（PowerShell）或 export DEBUG_GH=1（bash）后再运行同一命令。"
    );
  }
}
