#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import process from "node:process";
import * as XLSX from "xlsx";
import solc from "solc";
import { throwOnGhFailure, logGhFatalError } from "./gh-error-format.mjs";
import { spawnGh } from "./gh-runner.mjs";

const COMMENT_PREFIX = "[脚本审核建议] ";
const DEFAULT_REPO = "0xherstory/WWW6.5";
const DEFAULT_WEEK1_DEADLINE = "2026-03-09T00:00:00+08:00";
// 允许: day/Day + 数字 + 下划线或连字符 + 任意作业名 + .sol
const STRICT_SOL_NAME_RE = /^day(\d{1,2})[_-][^/\\]+\.sol$/i;
const DAY_IN_NAME_RE = /day\s*[-_ ]?\s*(\d{1,2})/i;

function parseArgs(argv) {
  const args = {
    repo: DEFAULT_REPO,
    output: "",
    apply: false,
    yes: false,
    mergeMethod: "squash",
    prFilter: null,
    week1Deadline: DEFAULT_WEEK1_DEADLINE,
    weekConfig: "",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--repo") args.repo = argv[++i] ?? args.repo;
    else if (token === "--output") args.output = argv[++i] ?? "";
    else if (token === "--apply") args.apply = true;
    else if (token === "--yes") args.yes = true;
    else if (token === "--merge-method") args.mergeMethod = (argv[++i] ?? "squash").toLowerCase();
    else if (token === "--week1-deadline") args.week1Deadline = argv[++i] ?? args.week1Deadline;
    else if (token === "--week-config") args.weekConfig = argv[++i] ?? "";
    else if (token === "--pr") {
      const raw = argv[++i] ?? "";
      args.prFilter = new Set(
        raw
          .split(",")
          .map((x) => Number(x.trim()))
          .filter((x) => Number.isInteger(x) && x > 0)
      );
    }
  }
  return args;
}

function runGh(args, input = null) {
  const result = spawnGh(args, input);
  if (result.error) {
    throw new Error(`无法启动 gh (${result.ghBin}): ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    const stdout = String(result.stdout || "").trim();
    throwOnGhFailure(stderr, stdout, {
      exitCode: result.status,
      signal: result.signal ?? null,
      ghBin: result.ghBin,
      ghArgs: [...args],
    });
  }
  return String(result.stdout || "").trim();
}

/** 判断是否为网络/API 异常（连接失败等），此类异常应对该 PR 不做任何处理，留待下次任务重试 */
function isNetworkError(err) {
  const msg = (err && err.message ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("error connecting") ||
    msg.includes("api.github.com") ||
    msg.includes("check your internet") ||
    msg.includes("githubstatus.com") ||
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("network")
  );
}

function ghApi(pathAndQuery, method = "GET", body = null) {
  const args = ["api", pathAndQuery, "-X", method, "-H", "Accept: application/vnd.github+json"];
  if (body != null) {
    args.push("--input", "-");
    return runGh(args, JSON.stringify(body));
  }
  return runGh(args);
}

function ghApiJson(pathAndQuery, method = "GET", body = null) {
  const text = ghApi(pathAndQuery, method, body);
  return text ? JSON.parse(text) : null;
}

function withPage(basePath, page) {
  return `${basePath}${basePath.includes("?") ? "&" : "?"}per_page=100&page=${page}`;
}

function fetchAllPages(basePath) {
  const rows = [];
  let page = 1;
  while (true) {
    const pathWithPage = withPage(basePath, page);
    const pageRows = ghApiJson(pathWithPage);
    if (!Array.isArray(pageRows)) break;
    rows.push(...pageRows);
    if (pageRows.length < 100) break;
    page += 1;
  }
  return rows;
}

function buildMergedDayIndex(owner, repo) {
  const repoInfo = ghApiJson(`/repos/${owner}/${repo}`);
  const defaultBranch = repoInfo?.default_branch || "main";
  const branchInfo = ghApiJson(`/repos/${owner}/${repo}/branches/${encodeURIComponent(defaultBranch)}`);
  const treeSha = branchInfo?.commit?.commit?.tree?.sha;
  if (!treeSha) return new Map();
  const treeInfo = ghApiJson(`/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`);
  const rows = Array.isArray(treeInfo?.tree) ? treeInfo.tree : [];
  const index = new Map();
  for (const row of rows) {
    if (row?.type !== "blob") continue;
    const p = String(row?.path || "");
    if (!/\.sol$/i.test(p)) continue;
    if (!p.includes("/")) continue;
    const folder = p.split("/")[0];
    const day = extractDay(path.basename(p));
    if (!Number.isInteger(day) || day < 1 || day > 30) continue;
    if (!index.has(folder)) index.set(folder, new Set());
    index.get(folder).add(day);
  }
  return index;
}

function toTopLevel(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  if (!normalized.includes("/")) return "";
  return normalized.split("/")[0];
}

function encodeGitHubPath(filePath) {
  return filePath
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function extractDay(fileName) {
  const m = fileName.match(DAY_IN_NAME_RE);
  return m ? Number(m[1]) : null;
}

function strictMatch(fileName) {
  const base = fileName.split("/").pop() ?? fileName;
  return STRICT_SOL_NAME_RE.test(base);
}

function getDayFromStrict(fileName) {
  const base = fileName.split("/").pop() ?? fileName;
  const m = base.match(STRICT_SOL_NAME_RE);
  return m ? Number(m[1]) : null;
}

function ensurePrefix(text) {
  if (!text) return COMMENT_PREFIX.trim();
  return text.startsWith(COMMENT_PREFIX) ? text : `${COMMENT_PREFIX}${text}`;
}

function compileSolidity(fileName, source) {
  const input = JSON.stringify({
    language: "Solidity",
    sources: { [fileName]: { content: source } },
    settings: { outputSelection: { "*": { "*": [] } } },
  });
  let output;
  try {
    output = JSON.parse(solc.compile(input));
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
  }
  const errors = (output.errors ?? []).filter((e) => e.severity === "error").map((e) => e.formattedMessage ?? e.message ?? String(e));
  return { ok: errors.length === 0, errors };
}

function compileSolidityWithSources(entryFilePath, sourcesMap) {
  const sources = {};
  for (const [name, content] of sourcesMap.entries()) {
    sources[name] = { content };
  }
  const input = JSON.stringify({
    language: "Solidity",
    sources,
    settings: { outputSelection: { "*": { "*": [] } } },
  });
  let output;
  try {
    output = JSON.parse(solc.compile(input));
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
  }
  const errors = (output.errors ?? []).filter((e) => e.severity === "error").map((e) => e.formattedMessage ?? e.message ?? String(e));
  return { ok: errors.length === 0, errors };
}

const EXTERNAL_IMPORT_WHITELIST = ["@openzeppelin/", "@chainlink/"];

function isWhitelistedExternalPath(p) {
  const normalized = String(p || "").replace(/\\/g, "/");
  return EXTERNAL_IMPORT_WHITELIST.some((prefix) => normalized.startsWith(prefix));
}

function fetchExternalFileFromNodeModules(virtualPath, fileCache) {
  const normalized = String(virtualPath || "").replace(/\\/g, "/");
  if (fileCache.has(normalized)) return fileCache.get(normalized);
  const diskPath = path.join(process.cwd(), "node_modules", ...normalized.split("/"));
  const content = fs.readFileSync(diskPath, "utf8");
  fileCache.set(normalized, content);
  return content;
}

function parseImports(sourceText) {
  const imports = [];
  const re = /^\s*import\s+(?:(?:[^'"]+from\s+)?["']([^"']+)["'])\s*;/gm;
  let m;
  while ((m = re.exec(sourceText)) !== null) {
    imports.push(m[1]);
  }
  return imports;
}

function resolveImportPath(currentPath, importPath) {
  const normalized = String(importPath || "").replace(/\\/g, "/");
  if (!normalized) return "";
  if (normalized.startsWith(".")) {
    const baseDir = path.posix.dirname(currentPath.replace(/\\/g, "/"));
    return path.posix.normalize(path.posix.join(baseDir, normalized));
  }
  return normalized;
}

function fetchRepoFileAtRef(owner, repo, filePath, ref, fileCache) {
  const normalized = filePath.replace(/\\/g, "/");
  if (fileCache.has(normalized)) return fileCache.get(normalized);
  const encoded = encodeGitHubPath(normalized);
  const info = ghApiJson(`/repos/${owner}/${repo}/contents/${encoded}?ref=${ref}`);
  const b64 = String(info?.content ?? "").replace(/\n/g, "");
  const content = Buffer.from(b64, "base64").toString("utf8");
  fileCache.set(normalized, content);
  return content;
}

function fetchSourceForPath(owner, repo, ref, normalizedPath, fileCache) {
  if (isWhitelistedExternalPath(normalizedPath)) {
    return fetchExternalFileFromNodeModules(normalizedPath, fileCache);
  }
  return fetchRepoFileAtRef(owner, repo, normalizedPath, ref, fileCache);
}

function collectSourceGraph(owner, repo, ref, entryPath, fileCache, visiting = new Set(), result = new Map()) {
  const normalizedEntry = entryPath.replace(/\\/g, "/");
  if (result.has(normalizedEntry)) return result;
  if (visiting.has(normalizedEntry)) return result;
  visiting.add(normalizedEntry);
  const source = fetchSourceForPath(owner, repo, ref, normalizedEntry, fileCache);
  result.set(normalizedEntry, source);
  const imports = parseImports(source);
  for (const imp of imports) {
    const resolved = resolveImportPath(normalizedEntry, imp);
    if (!resolved) continue;
    try {
      collectSourceGraph(owner, repo, ref, resolved, fileCache, visiting, result);
    } catch (_) {
      // 外部依赖或不存在文件交给 solc 给出具体错误
    }
  }
  visiting.delete(normalizedEntry);
  return result;
}

function hasEffectiveAddedDiff(file) {
  // GitHub diff may provide this marker when only whitespace changed.
  const patch = String(file?.patch ?? "");
  if (!patch) return true;
  if (patch.includes("Whitespace-only changes.")) return false;
  return true;
}

function toCnTimeText(date) {
  return new Date(date).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
}

function getWeekFromDay(dayNum) {
  if (!Number.isInteger(dayNum) || dayNum < 1 || dayNum > 30) return null;
  const weekNo = Math.ceil(dayNum / 7);
  const startDay = (weekNo - 1) * 7 + 1;
  const endDay = Math.min(weekNo * 7, 30);
  return { weekNo, startDay, endDay };
}

function getWeekDeadlineByWeekNo(week1DeadlineIso, weekNo) {
  const base = new Date(week1DeadlineIso);
  if (Number.isNaN(base.getTime()) || !Number.isInteger(weekNo) || weekNo < 1) return null;
  const plusMs = (weekNo - 1) * 7 * 24 * 60 * 60 * 1000;
  return new Date(base.getTime() + plusMs);
}

function buildDefaultWeekConfigs(week1DeadlineIso) {
  const configs = [];
  for (let startDay = 1, idx = 1; startDay <= 30; startDay += 7, idx += 1) {
    const endDay = Math.min(startDay + 6, 30);
    const deadline = getWeekDeadlineByWeekNo(week1DeadlineIso, idx);
    configs.push({
      id: `week${idx}`,
      order: idx,
      startDay,
      endDay,
      deadlineIso: deadline ? deadline.toISOString() : week1DeadlineIso,
    });
  }
  return configs;
}

function parseWeekConfigFile(filePath) {
  const absolute = path.resolve(process.cwd(), filePath);
  const text = fs.readFileSync(absolute, "utf8");
  const parsed = JSON.parse(text);
  const rows = Array.isArray(parsed?.weeks) ? parsed.weeks : [];
  if (rows.length === 0) throw new Error("week-config 配置无效: weeks 不能为空数组");
  return rows.map((row, index) => {
    const id = String(row?.id ?? `week${index + 1}`);
    const startDay = Number(row?.startDay);
    const endDay = Number(row?.endDay);
    const deadlineIso = String(row?.deadline ?? "");
    const deadline = new Date(deadlineIso);
    if (!Number.isInteger(startDay) || !Number.isInteger(endDay) || startDay < 1 || endDay > 30 || startDay > endDay) {
      throw new Error(`week-config 配置无效: ${id} 的 day 范围不合法`);
    }
    if (Number.isNaN(deadline.getTime())) {
      throw new Error(`week-config 配置无效: ${id} 的 deadline 不是合法时间`);
    }
    return {
      id,
      order: index + 1,
      startDay,
      endDay,
      deadlineIso,
    };
  });
}

function resolveWeekConfig(args) {
  const configs = args.weekConfig ? parseWeekConfigFile(args.weekConfig) : buildDefaultWeekConfigs(args.week1Deadline);
  const sorted = configs.sort((a, b) => a.order - b.order);
  const usedIds = new Set();
  for (const row of sorted) {
    if (usedIds.has(row.id)) throw new Error(`week-config 配置无效: 存在重复 id ${row.id}`);
    usedIds.add(row.id);
  }
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const cur = sorted[i];
    const next = sorted[i + 1];
    if (cur.endDay >= next.startDay) {
      throw new Error(`week-config 配置无效: ${cur.id} 与 ${next.id} 的 day 范围重叠`);
    }
  }
  return sorted;
}

function findWeekByDay(dayNum, weekConfigs) {
  if (!Number.isInteger(dayNum)) return null;
  return weekConfigs.find((x) => dayNum >= x.startDay && dayNum <= x.endDay) ?? null;
}

function buildLateLabelSet(existingLabels, lateLabel) {
  const names = new Set(
    (existingLabels ?? [])
      .map((x) => (typeof x === "string" ? x : x?.name))
      .filter((x) => typeof x === "string" && x.trim())
  );
  for (const name of [...names]) {
    if (/^week\d+-late$/i.test(name)) names.delete(name);
  }
  names.add(lateLabel);
  return [...names];
}

function summarizeActions(actions) {
  if (actions.length === 0) return "无";
  return actions
    .map((a) => {
      if (a.type === "comment") return `评论: ${a.body}`;
      if (a.type === "close") return "关闭PR";
      if (a.type === "retitle") return `改标题: ${a.title}`;
      if (a.type === "merge") return `合并PR(${a.mergeMethod ?? "squash"})`;
      if (a.type === "add_labels") return `添加标签: ${(a.labels ?? []).join(", ")}`;
      return a.type;
    })
    .join(" | ");
}

function buildExecutionActions(item, mergeMethod) {
  const actions = [...item.actions];
  if (item.conclusion === "待人工审核") {
    // 通过全部规则的 PR 自动合并
    actions.push({ type: "merge", mergeMethod });
    // 合并成功后再做超时标签/提示，避免未合并状态污染统计
    if (item.lateLabels?.length) {
      actions.push({
        type: "add_labels",
        labels: item.lateLabels,
      });
      actions.push({
        type: "comment",
        body: `检测到本次提交存在补交超时作业（${item.lateWeekSummary}），已打上超时标签 ${item.lateLabels.join(", ")}。别灰心，你可以按自己的学习节奏继续完成并提交作业，最重要的是在共学过程中真正锻炼学习能力，我们会一直为你的进步加油。`,
      });
    }
  }
  // 不通过的 PR 在检查阶段已包含 close，无需追加
  return actions;
}

async function askYesNo(rl, question, defaultNo = true) {
  const answer = (await rl.question(question)).trim().toLowerCase();
  if (!answer) return !defaultNo;
  return answer === "y" || answer === "yes";
}

function executeOneAction(owner, repo, prNumber, action) {
  if (action.type === "comment") {
    ghApiJson(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, "POST", {
      body: ensurePrefix(action.body),
    });
    return;
  }
  if (action.type === "retitle") {
    ghApiJson(`/repos/${owner}/${repo}/pulls/${prNumber}`, "PATCH", {
      title: action.title,
    });
    return;
  }
  if (action.type === "close") {
    ghApiJson(`/repos/${owner}/${repo}/pulls/${prNumber}`, "PATCH", {
      state: "closed",
    });
    return;
  }
  if (action.type === "merge") {
    ghApiJson(`/repos/${owner}/${repo}/pulls/${prNumber}/merge`, "PUT", {
      merge_method: action.mergeMethod ?? "squash",
    });
    const now = new Date();
    const isWomenDay = now.getMonth() === 2 && now.getDate() === 8;
    if (isWomenDay) {
      ghApiJson(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, "POST", {
        body: ensurePrefix("PR已成功提交！妇女节快乐~"),
      });
    }
    return;
  }
  if (action.type === "add_labels") {
    const labels = Array.isArray(action.labels) ? action.labels.filter(Boolean) : [];
    if (labels.length > 0) {
      ghApiJson(`/repos/${owner}/${repo}/issues/${prNumber}/labels`, "POST", { labels });
    }
    return;
  }
  throw new Error(`未知动作类型: ${action.type}`);
}

function formatNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function getMaxDayFromAddedSol(addedSolFiles) {
  const days = addedSolFiles.map((f) => extractDay(path.basename(f.filename))).filter((x) => Number.isInteger(x));
  if (days.length === 0) return null;
  return Math.max(...days);
}

function expectedTitle(login, dayN) {
  return `提交人${login} 挑战尝试闯关到Day${dayN}`;
}

function buildResultRow(item) {
  return {
    pr序号: item.pr.number,
    pr链接: item.pr.html_url,
    提交人: item.submitter || "",
    提交时间: item.submittedAtCn || "",
    week: item.weekLabel || "",
    week_day_range: item.weekDayRange || "",
    week_deadline: item.weekDeadlineCn || "",
    week_is_late: item.isWeekLate == null ? "" : item.isWeekLate ? "Y" : "N",
    week_late_reason: item.weekLateReason || "",
    检查的总路径: item.path.join(" -> "),
    owner_folder: item.ownerFolder || "",
    touched_top_level_folders: item.touchedTopLevelFolders.length ? item.touchedTopLevelFolders.join(", ") : "",
    compile_error_reason: item.compileErrorReason || "",
    涉及的操作: summarizeActions(item.actions),
    检查结论: item.conclusion,
  };
}

function buildWeekStats(results) {
  const byWeek = new Map();
  for (const item of results) {
    if (!item.weekLabel) continue;
    if (!byWeek.has(item.weekLabel)) {
      byWeek.set(item.weekLabel, {
        week: item.weekLabel,
        weekOrder: item.weekOrder ?? 999,
        dayRange: item.weekDayRange,
        deadline: item.weekDeadlineCn || "",
        submitters: new Set(),
        passSubmitters: new Set(),
        onTimePassSubmitters: new Set(),
        latePassSubmitters: new Set(),
      });
    }
    const row = byWeek.get(item.weekLabel);
    row.submitters.add(item.submitter);
    const passed = item.conclusion !== "不通过";
    if (passed) {
      row.passSubmitters.add(item.submitter);
      if (item.isWeekLate) row.latePassSubmitters.add(item.submitter);
      else row.onTimePassSubmitters.add(item.submitter);
    }
  }
  const pct = (num, den) => (den === 0 ? "0.00%" : `${((num / den) * 100).toFixed(2)}%`);
  return [...byWeek.values()]
    .sort((a, b) => a.weekOrder - b.weekOrder)
    .map((x) => {
      const submitterCount = x.submitters.size;
      const passCount = x.passSubmitters.size;
      const onTimePassCount = x.onTimePassSubmitters.size;
      const latePassCount = x.latePassSubmitters.size;
      return {
        week: x.week,
        day_range: x.dayRange,
        deadline: x.deadline,
        submitter_count: submitterCount,
        pass_submitter_count: passCount,
        ontime_pass_submitter_count: onTimePassCount,
        late_pass_submitter_count: latePassCount,
        success_rate: pct(passCount, submitterCount),
        ontime_success_rate: pct(onTimePassCount, submitterCount),
        late_success_rate: pct(latePassCount, submitterCount),
      };
    });
}

async function main() {
  const args = parseArgs(process.argv);
  const [owner, repo] = args.repo.split("/");
  if (!owner || !repo) throw new Error("repo 参数格式必须是 owner/repo");
  const weekConfigs = resolveWeekConfig(args);
  const mergedDayIndex = buildMergedDayIndex(owner, repo);

  const reportDir = path.resolve(process.cwd(), "prautocheck", "reports");
  fs.mkdirSync(reportDir, { recursive: true });
  const outputFile = args.output
    ? path.resolve(process.cwd(), args.output)
    : path.join(reportDir, `pr-precheck-${formatNow()}.xlsx`);

  console.log(`开始预检查仓库: ${args.repo}`);
  const allOpenPrs = fetchAllPages(`/repos/${owner}/${repo}/pulls?state=open`)
    .filter((pr) => !args.prFilter || args.prFilter.has(pr.number))
    .sort((a, b) => a.number - b.number);
  console.log(`拉取到 open PR 数量: ${allOpenPrs.length}`);
  if (allOpenPrs.length === 0) {
    console.log("当前没有待审核的 open PR，已跳过报告输出与执行流程。");
    return;
  }

  const results = [];
  for (const pr of allOpenPrs) {
    try {
      console.log(`\n[检查] PR #${pr.number} ${pr.html_url}`);
      const files = fetchAllPages(`/repos/${owner}/${repo}/pulls/${pr.number}/files`);
    const addedSol = files.filter((f) => f.status === "added" && /\.sol$/i.test(f.filename));
    const touchedTopLevel = new Set(files.map((f) => toTopLevel(f.filename)).filter(Boolean));
    const nonRootTopLevel = new Set(files.filter((f) => f.filename.includes("/")).map((f) => toTopLevel(f.filename)).filter(Boolean));
    const pathMarks = [];
    const actions = [];
    let ownerFolder = "";
    let compileErrorReason = "";
    let conclusion = "待人工审核";
    let stopFurther = false;
    const submitter = pr.user?.login ?? "";
    const submittedAt = pr.created_at ? new Date(pr.created_at) : null;
    const submittedAtCn = submittedAt && !Number.isNaN(submittedAt.getTime()) ? toCnTimeText(submittedAt) : "";
    const maxDayInPr = getMaxDayFromAddedSol(addedSol);
    const weekInfo = findWeekByDay(maxDayInPr, weekConfigs);
    const weekLabel = weekInfo ? weekInfo.id : "";
    const weekOrder = weekInfo ? weekInfo.order : null;
    const weekDayRange = weekInfo ? `day${weekInfo.startDay}-day${weekInfo.endDay}` : "";
    const weekDeadline = weekInfo ? new Date(weekInfo.deadlineIso) : null;
    const weekDeadlineCn = weekDeadline ? toCnTimeText(weekDeadline) : "";
    const isWeekLate =
      weekInfo && weekDeadline && submittedAt && !Number.isNaN(submittedAt.getTime()) ? submittedAt.getTime() > weekDeadline.getTime() : null;
    const weekLateReason =
      isWeekLate === true && weekInfo
        ? `该PR属于${weekLabel}(${weekDayRange})，提交时间 ${submittedAtCn} 晚于截止时间 ${weekDeadlineCn}`
        : "";
    const ownerFolderFromAddedSolCandidates = new Set(addedSol.map((f) => toTopLevel(f.filename)).filter(Boolean));
    const ownerFolderFromAddedSol = ownerFolderFromAddedSolCandidates.size === 1 ? [...ownerFolderFromAddedSolCandidates][0] : "";
    const mergedDaysOfOwner = ownerFolderFromAddedSol ? mergedDayIndex.get(ownerFolderFromAddedSol) ?? new Set() : new Set();
    const addedDaysInPr = [...new Set(addedSol.map((f) => extractDay(path.basename(f.filename))).filter((d) => Number.isInteger(d) && d >= 1 && d <= 30))];
    const fullyNewDays = addedDaysInPr.filter((d) => !mergedDaysOfOwner.has(d));
    const lateWeekMap = new Map();
    for (const day of fullyNewDays) {
      const wk = findWeekByDay(day, weekConfigs);
      if (!wk || !submittedAt || Number.isNaN(submittedAt.getTime())) continue;
      const ddl = new Date(wk.deadlineIso);
      if (submittedAt.getTime() > ddl.getTime()) {
        lateWeekMap.set(wk.id, {
          id: wk.id,
          label: `${wk.id}-late`,
          dayRange: `day${wk.startDay}-day${wk.endDay}`,
          deadlineCn: toCnTimeText(ddl),
        });
      }
    }
    const lateLabels = [...lateWeekMap.values()].map((x) => x.label);
    const lateWeekSummary = [...lateWeekMap.values()].map((x) => `${x.id}(${x.dayRange})`).join("、");

    // pre-0 灾难性改动检查：删除了多个主目录下一层文件夹
    const removedTopLevelFolders = new Set(
      files
        .filter((f) => f.status === "removed" && f.filename.includes("/"))
        .map((f) => toTopLevel(f.filename))
        .filter(Boolean)
    );
    if (removedTopLevelFolders.size >= 2) {
      pathMarks.push("pre-0-1");
      actions.push({
        type: "comment",
        body: "这个PR我关闭啦，因为删到了别人的文件夹。如果你想重来一遍可以重新 fork 仓库后正确新增自己的作业文件夹，别动其他文件夹，提交新PR。",
      });
      actions.push({ type: "close" });
      conclusion = "不通过";
      stopFurther = true;
    }

    // 0
    if (!stopFurther && addedSol.length === 0) {
      pathMarks.push("0-1");
      actions.push({ type: "comment", body: "没找到 `.sol` 文件呢，是不是忘记加后缀名啦？" });
      actions.push({ type: "close" });
      conclusion = "不通过";
      stopFurther = true;
    } else if (!stopFurther) {
      pathMarks.push("0-2");
    }

    // 0.5 新增文件夹名称空格检查（位于步骤0和1之间）
    if (!stopFurther) {
      const folderNamesWithSpaces = new Set();
      for (const file of files) {
        if (file.status !== "added") continue;
        const normalized = String(file.filename || "").replace(/\\/g, "/");
        if (!normalized.includes("/")) continue;
        const parts = normalized.split("/");
        // 最后一段是文件名，仅检查文件夹段
        for (let i = 0; i < parts.length - 1; i += 1) {
          if (/\s/.test(parts[i])) {
            folderNamesWithSpaces.add(parts[i]);
          }
        }
      }
      if (folderNamesWithSpaces.size > 0) {
        pathMarks.push("0-2-space-folder");
        actions.push({ type: "comment", body: "你新增的文件夹名称包含空格，请删除空格后重新提交" });
        actions.push({ type: "close" });
        conclusion = "不通过";
        stopFurther = true;
      }
    }

    // 1
    if (!stopFurther) {
      const fileMeta = addedSol.map((f) => {
        const base = path.basename(f.filename);
        return {
          file: f,
          base,
          dayNum: extractDay(base),
        };
      });
      const hasNoDay = fileMeta.some((x) => x.dayNum == null);
      if (hasNoDay) {
        pathMarks.push("1-1-1");
        actions.push({ type: "comment", body: "请按照 day{n}_{作业名}.sol 更新正确的文件名" });
        actions.push({ type: "close" });
        conclusion = "不通过";
        stopFurther = true;
      } else {
        pathMarks.push("1-2");
      }
    }

    // 2
    if (!stopFurther) {
      if (!maxDayInPr) {
        pathMarks.push("2-unknown");
        conclusion = "待人工审核";
      } else {
        const targetTitle = expectedTitle(pr.user.login, maxDayInPr);
        if (pr.title.trim() !== targetTitle) {
          pathMarks.push("2-1");
          actions.push({ type: "retitle", title: targetTitle });
        } else {
          pathMarks.push("2-2");
        }
      }
    }

    // 3
    if (!stopFurther) {
      const addedInRoot = files.some((f) => f.status === "added" && !f.filename.includes("/"));
      if (addedInRoot) {
        pathMarks.push("3-1");
        actions.push({
          type: "comment",
          body: "发现你有放错位置的文件呢，请把所有文件放进你自己的文件夹里，别放在外面",
        });
        actions.push({ type: "close" });
        conclusion = "不通过";
        stopFurther = true;
      } else if (touchedTopLevel.has("bala")) {
        pathMarks.push("3-2-1");
        actions.push({ type: "comment", body: "不要增删bala文件夹下的文件" });
        actions.push({ type: "close" });
        conclusion = "不通过";
        stopFurther = true;
      } else {
        const ownerFolderCandidates = new Set(addedSol.map((f) => toTopLevel(f.filename)).filter(Boolean));
        // 规则: 一个PR只能落在主目录下一层的一个个人文件夹中
        if (ownerFolderCandidates.size !== 1) {
          pathMarks.push("3-2-2");
          actions.push({ type: "comment", body: "你删改了别人的文件，请重新fork，只上传你自己文件夹里的作业" });
          actions.push({ type: "close" });
          conclusion = "不通过";
          stopFurther = true;
        } else {
          ownerFolder = [...ownerFolderCandidates][0];
          const touchedOtherTopLevel = [...nonRootTopLevel].filter((seg) => seg !== ownerFolder);
          if (touchedOtherTopLevel.length > 0) {
            pathMarks.push("3-2-2");
            actions.push({ type: "comment", body: "你删改了别人的文件，请重新fork，只上传你自己文件夹里的作业" });
            actions.push({ type: "close" });
            conclusion = "不通过";
            stopFurther = true;
          } else {
            pathMarks.push("3-2-3");
          }
        }
      }
    }

    // 4-0
    if (!stopFurther) {
      const allWhitespaceOnly = addedSol.length > 0 && addedSol.every((f) => !hasEffectiveAddedDiff(f));
      if (allWhitespaceOnly) {
        pathMarks.push("4-0");
        actions.push({ type: "comment", body: "未见实际新增改动，空白改动不支持合并" });
        actions.push({ type: "close" });
        conclusion = "不通过";
        stopFurther = true;
      }
    }

    // 4-1 / 4-2
    if (!stopFurther) {
      const failedDetails = [];
      const fileCache = new Map();
      for (const file of addedSol) {
        try {
          const sourceGraph = collectSourceGraph(owner, repo, pr.head.sha, file.filename, fileCache);
          const result = compileSolidityWithSources(file.filename.replace(/\\/g, "/"), sourceGraph);
          if (!result.ok) {
            failedDetails.push({
              file: path.basename(file.filename),
              reason: (result.errors || []).slice(0, 2).join(" || "),
            });
          }
        } catch (err) {
          if (isNetworkError(err)) throw err;
          failedDetails.push({
            file: path.basename(file.filename),
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (failedDetails.length > 0) {
        pathMarks.push("4-1");
        const fileList = failedDetails.map((x) => `\`${x.file}\``).join("、");
        compileErrorReason = failedDetails.map((x) => `${x.file}: ${x.reason}`).join(" | ");
        const maxReasonLen = 400;
        const errorSummary = failedDetails
          .map((x) => {
            const r = String(x.reason).replace(/\s+/g, " ").trim();
            const text = r.length > maxReasonLen ? r.slice(0, maxReasonLen) + "…" : r;
            return `- **${x.file}**：${text}`;
          })
          .join("\n");
        const commentBody = `以下文件无法正常编译，请检查后重新提交：${fileList}\n\n**编译报错摘要：**\n\n${errorSummary}`;
        actions.push({ type: "comment", body: commentBody });
        actions.push({ type: "close" });
        conclusion = "不通过";
      } else {
        pathMarks.push("4-2");
        conclusion = "待人工审核";
      }
    }

    if (lateLabels.length > 0) pathMarks.push("week-late");

      results.push({
        pr,
        submitter,
        submittedAtCn,
        weekLabel,
        weekOrder,
        weekDayRange,
        weekDeadlineCn,
        isWeekLate,
        weekLateReason,
        lateLabels,
        lateWeekSummary,
        path: pathMarks,
        actions,
        ownerFolder,
        touchedTopLevelFolders: [...nonRootTopLevel].sort(),
        compileErrorReason,
        conclusion,
      });
    } catch (err) {
      if (isNetworkError(err)) {
        console.log(`[跳过] PR #${pr.number} 因网络异常未处理，将留待下次任务重试: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      throw err;
    }
  }

  const rows = results.map(buildResultRow);
  const weekStatsRows = buildWeekStats(results);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, "check_result");
  const wsStats = XLSX.utils.json_to_sheet(weekStatsRows);
  XLSX.utils.book_append_sheet(wb, wsStats, "week_stats");
  XLSX.writeFile(wb, outputFile);
  console.log(`\nExcel 报告已输出: ${outputFile}`);

  const executionPlan = results
    .map((item) => ({
      ...item,
      executionActions: buildExecutionActions(item, args.mergeMethod),
    }))
    .filter((item) => item.executionActions.length > 0);

  // 无论模式，先输出执行摘要
  const mergeCount = executionPlan.filter((x) => x.executionActions.some((a) => a.type === "merge")).length;
  const closeCount = executionPlan.filter((x) => x.executionActions.some((a) => a.type === "close")).length;
  console.log(`\n--- 执行摘要 ---`);
  console.log(`不通过(待关闭) PR 数: ${closeCount}`);
  console.log(`待人工审核(待合并) PR 数: ${mergeCount}`);
  console.log(`合计命中 PR 数: ${executionPlan.length}`);

  if (!args.apply) {
    console.log("\n当前为预览模式，报告已输出，不会执行任何操作。");
    console.log("如需执行，请使用: node prautocheck/pr-precheck.mjs --apply");
    return;
  }
  if (executionPlan.length === 0) {
    console.log("没有需要执行的 PR，结束。");
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const success = [];
  let failed = [];
  try {
    if (!args.yes) {
      const confirmed = await askYesNo(rl, "\n确认执行？不通过的PR将被关闭，待审核的PR将被合并 (y/N): ");
      if (!confirmed) {
        console.log("已取消执行。");
        return;
      }
    }

    let pending = executionPlan;
    let round = 1;
    while (pending.length > 0) {
      console.log(`\n开始执行第 ${round} 轮，PR 数量: ${pending.length}`);
      failed = [];
      for (const item of pending) {
        try {
          for (const action of item.executionActions) {
            executeOneAction(owner, repo, item.pr.number, action);
          }
          if (!success.includes(item.pr.number)) success.push(item.pr.number);
          console.log(`PR #${item.pr.number} 执行成功`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failed.push({
            pr: item.pr.number,
            error: message,
            item,
          });
          console.log(`PR #${item.pr.number} 执行失败: ${message}`);
        }
      }

      if (failed.length === 0) break;
      if (args.yes) break;

      const retry = await askYesNo(rl, "检测到失败PR，是否重试失败项? (y/N): ");
      if (!retry) break;
      pending = failed.map((x) => x.item);
      round += 1;
      if (round > 5) {
        console.log("已达到最大重试轮数(5)，停止重试。");
        break;
      }
    }
  } finally {
    rl.close();
  }

  console.log("\n批量执行结果:");
  console.log(`成功 PR: ${success.length ? success.join(", ") : "无"}`);
  if (failed.length) {
    console.log("失败 PR:");
    for (const row of failed) console.log(`- #${row.pr}: ${row.error}`);
  } else {
    console.log("失败 PR: 无");
  }
}

main().catch((err) => {
  logGhFatalError(err);
  process.exit(1);
});

