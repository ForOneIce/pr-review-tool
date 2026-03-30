#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import * as XLSX from "xlsx";
import { throwOnGhFailure, logGhFatalError } from "./gh-error-format.mjs";
import { spawnGh } from "./gh-runner.mjs";

const DEFAULT_REPO = "0xherstory/WWW6.5";
const DEFAULT_WEEK1_DEADLINE = "2026-03-09T00:00:00+08:00";
const DAY_IN_NAME_RE = /day\s*[-_ ]?\s*(\d{1,2})/i;

function parseArgs(argv) {
  const args = {
    repo: DEFAULT_REPO,
    output: "",
    week1Deadline: DEFAULT_WEEK1_DEADLINE,
    weekConfig: "",
    quiet: false,
    mode: "api",
    repoRoot: process.cwd(),
    folderMap: "",
  };
  const positional = [];
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--repo") args.repo = argv[++i] ?? args.repo;
    else if (token === "--output") args.output = argv[++i] ?? "";
    else if (token === "--week1-deadline") args.week1Deadline = argv[++i] ?? args.week1Deadline;
    else if (token === "--week-config") args.weekConfig = argv[++i] ?? "";
    else if (token === "--quiet") args.quiet = true;
    else if (token === "--mode") args.mode = (argv[++i] ?? "api").toLowerCase();
    else if (token === "--repo-root") args.repoRoot = argv[++i] ?? args.repoRoot;
    else if (token === "--folder-map") args.folderMap = argv[++i] ?? "";
    else if (!token.startsWith("-")) positional.push(token);
  }
  // npm/powershell 可能把命名参数剥离成位置参数，这里做兜底解析
  if (positional.length > 0) {
    let idx = 0;
    if (!argv.includes("--mode") && positional[idx]) args.mode = String(positional[idx++]).toLowerCase();
    if (!argv.includes("--repo") && positional[idx]) args.repo = positional[idx++];
    if (!argv.includes("--repo-root") && positional[idx]) args.repoRoot = positional[idx++];
    if (!argv.includes("--week-config") && positional[idx]) args.weekConfig = positional[idx++];
    if (!argv.includes("--folder-map") && positional[idx]) args.folderMap = positional[idx++];
    if (!argv.includes("--output") && positional[idx]) args.output = positional[idx++];
    if (!argv.includes("--quiet") && positional[idx]) {
      const maybeQuiet = String(positional[idx]).toLowerCase();
      if (maybeQuiet === "quiet" || maybeQuiet === "true") args.quiet = true;
    }
  }
  if (!["api", "filesystem"].includes(args.mode)) {
    throw new Error("--mode 仅支持 api | filesystem");
  }
  return args;
}

function runGh(args) {
  const result = spawnGh(args);
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

function ghApiJson(pathAndQuery) {
  const text = runGh(["api", pathAndQuery, "-H", "Accept: application/vnd.github+json"]);
  return text ? JSON.parse(text) : null;
}

function withPage(basePath, page) {
  return `${basePath}${basePath.includes("?") ? "&" : "?"}per_page=100&page=${page}`;
}

function fetchAllPages(basePath) {
  const rows = [];
  let page = 1;
  while (true) {
    const pageRows = ghApiJson(withPage(basePath, page));
    if (!Array.isArray(pageRows)) break;
    rows.push(...pageRows);
    if (pageRows.length < 100) break;
    page += 1;
  }
  return rows;
}

function extractDay(fileName) {
  const m = String(fileName || "").match(DAY_IN_NAME_RE);
  return m ? Number(m[1]) : null;
}

function toTopLevel(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  if (!normalized.includes("/")) return "";
  return normalized.split("/")[0];
}

function toCnTimeText(date) {
  return new Date(date).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

function getWeekDeadlineByWeekNo(week1DeadlineIso, weekNo) {
  const base = new Date(week1DeadlineIso);
  if (Number.isNaN(base.getTime()) || !Number.isInteger(weekNo) || weekNo < 1) return null;
  return new Date(base.getTime() + (weekNo - 1) * 7 * 24 * 60 * 60 * 1000);
}

function buildDefaultWeekConfigs(week1DeadlineIso) {
  const rows = [];
  for (let startDay = 1, idx = 1; startDay <= 30; startDay += 7, idx += 1) {
    const endDay = Math.min(startDay + 6, 30);
    const deadline = getWeekDeadlineByWeekNo(week1DeadlineIso, idx);
    rows.push({
      id: `week${idx}`,
      order: idx,
      startDay,
      endDay,
      deadlineIso: deadline ? deadline.toISOString() : week1DeadlineIso,
    });
  }
  return rows;
}

function parseWeekConfigFile(filePath) {
  const absolute = path.resolve(process.cwd(), filePath);
  const parsed = JSON.parse(fs.readFileSync(absolute, "utf8"));
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
    return { id, order: index + 1, startDay, endDay, deadlineIso };
  });
}

function resolveWeekConfig(args) {
  const configs = args.weekConfig ? parseWeekConfigFile(args.weekConfig) : buildDefaultWeekConfigs(args.week1Deadline);
  const sorted = configs.sort((a, b) => a.order - b.order);
  for (let i = 0; i < sorted.length - 1; i += 1) {
    if (sorted[i].endDay >= sorted[i + 1].startDay) {
      throw new Error(`week-config 配置无效: ${sorted[i].id} 与 ${sorted[i + 1].id} 的 day 范围重叠`);
    }
  }
  return sorted;
}

function findWeekByDay(day, weekConfigs) {
  if (!Number.isInteger(day)) return null;
  return weekConfigs.find((w) => day >= w.startDay && day <= w.endDay) ?? null;
}

function dayRangeText(w) {
  return `day${w.startDay}-day${w.endDay}`;
}

function pct(num, den) {
  return den === 0 ? "0.00%" : `${((num / den) * 100).toFixed(2)}%`;
}

function formatNowForFile() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function withTimestampSuffix(targetPath) {
  const parsed = path.parse(targetPath);
  return path.join(parsed.dir, `${parsed.name}-${formatNowForFile()}${parsed.ext || ".xlsx"}`);
}

function loadFolderMap(filePath) {
  if (!filePath) return new Map();
  const absolute = path.resolve(process.cwd(), filePath);
  const parsed = JSON.parse(fs.readFileSync(absolute, "utf8"));
  const folderToGithub = new Map();
  for (const [github, raw] of Object.entries(parsed || {})) {
    const folders = Array.isArray(raw) ? raw : [raw];
    for (const folder of folders.map((x) => String(x || "").trim()).filter(Boolean)) {
      if (!folderToGithub.has(folder)) folderToGithub.set(folder, new Set());
      folderToGithub.get(folder).add(github);
    }
  }
  return folderToGithub;
}

const PR_FILES_FETCH_RETRIES = 3;

/**
 * 查询带超时标签的 PR，并识别该 PR 提交内容中的昵称文件夹（顶层目录），保证 late 表的 owner_folders 数据正确。
 * 单次 PR 的 files 请求失败时重试 3 次，仍失败则记入 lateFetchErrorKeys，表格中标记「异常」。
 * 返回 { lateByWeek, lateFoldersByWeekAccount, lateFetchErrorKeys: Set("weekId::login") }
 */
function fetchLateAccountsAndFoldersByWeek(owner, repo, weekConfigs) {
  const lateByWeek = new Map();
  const lateFoldersByWeekAccount = new Map();
  const lateFetchErrorKeys = new Set();
  for (const week of weekConfigs) {
    const label = `${week.id}-late`;
    const issues = fetchAllPages(`/repos/${owner}/${repo}/issues?state=all&labels=${encodeURIComponent(label)}`);
    const prs = issues.filter((x) => x?.pull_request);
    const accounts = new Set();
    for (const issue of prs) {
      const login = issue?.user?.login;
      if (typeof login !== "string" || !login) continue;
      accounts.add(login);
      const prNumber = issue.number;
      const key = `${week.id}::${login}`;
      let lastErr = null;
      for (let attempt = 1; attempt <= PR_FILES_FETCH_RETRIES; attempt += 1) {
        try {
          const files = fetchAllPages(`/repos/${owner}/${repo}/pulls/${prNumber}/files`);
          const folders = new Set(
            files
              .filter((f) => f.status === "added" && /\.sol$/i.test(String(f.filename)))
              .map((f) => toTopLevel(f.filename))
              .filter(Boolean)
          );
          if (folders.size > 0) {
            if (!lateFoldersByWeekAccount.has(key)) lateFoldersByWeekAccount.set(key, new Set());
            for (const folder of folders) lateFoldersByWeekAccount.get(key).add(folder);
          }
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
        }
      }
      if (lastErr) lateFetchErrorKeys.add(key);
    }
    lateByWeek.set(week.id, accounts);
  }
  return { lateByWeek, lateFoldersByWeekAccount, lateFetchErrorKeys };
}

function listTopLevelFolders(repoRoot) {
  return fs
    .readdirSync(repoRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => !name.startsWith(".") && !["node_modules", "prautocheck", "src", "public", "dist"].includes(name));
}

function collectSolDaysInFolder(folderPath) {
  const days = new Set();
  const stack = [folderPath];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && /\.sol$/i.test(entry.name)) {
        const day = extractDay(entry.name);
        if (Number.isInteger(day) && day >= 1 && day <= 30) days.add(day);
      }
    }
  }
  return [...days].sort((a, b) => a - b);
}

function collectFolderDayMapFromLocal(repoRoot) {
  const folderDayMap = new Map();
  const topFolders = listTopLevelFolders(repoRoot);
  for (const folder of topFolders) {
    const folderPath = path.join(repoRoot, folder);
    const days = collectSolDaysInFolder(folderPath);
    if (days.length > 0) folderDayMap.set(folder, days);
  }
  return folderDayMap;
}

function collectFolderDayMapFromRemote(owner, repo) {
  const repoInfo = ghApiJson(`/repos/${owner}/${repo}`);
  const defaultBranch = repoInfo?.default_branch || "main";
  const branchInfo = ghApiJson(`/repos/${owner}/${repo}/branches/${encodeURIComponent(defaultBranch)}`);
  const treeSha = branchInfo?.commit?.commit?.tree?.sha;
  if (!treeSha) return new Map();
  const treeInfo = ghApiJson(`/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`);
  const rows = Array.isArray(treeInfo?.tree) ? treeInfo.tree : [];
  const folderDaySetMap = new Map();
  for (const row of rows) {
    if (row?.type !== "blob") continue;
    const p = String(row?.path || "");
    if (!/\.sol$/i.test(p) || !p.includes("/")) continue;
    const folder = p.split("/")[0];
    const day = extractDay(path.basename(p));
    if (!Number.isInteger(day) || day < 1 || day > 30) continue;
    if (!folderDaySetMap.has(folder)) folderDaySetMap.set(folder, new Set());
    folderDaySetMap.get(folder).add(day);
  }
  const folderDayMap = new Map();
  for (const [folder, daySet] of folderDaySetMap.entries()) {
    folderDayMap.set(folder, [...daySet].sort((a, b) => a - b));
  }
  return folderDayMap;
}

async function main() {
  const args = parseArgs(process.argv);
  const log = (...items) => {
    if (!args.quiet) console.log(...items);
  };
  const [owner, repo] = args.repo.split("/");
  if (!owner || !repo) throw new Error("repo 参数格式必须是 owner/repo");
  const weekConfigs = resolveWeekConfig(args);
  const weekConfigById = new Map(weekConfigs.map((w) => [w.id, w]));

  const reportDir = path.resolve(process.cwd(), "prautocheck", "reports");
  fs.mkdirSync(reportDir, { recursive: true });
  const outputFile = args.output
    ? withTimestampSuffix(path.resolve(process.cwd(), args.output))
    : path.join(reportDir, `pr-stats-${formatNowForFile()}.xlsx`);

  const dayRecords = [];
  let lateByWeekForReport = null;
  let lateFoldersByWeekAccount = new Map();
  let lateFetchErrorKeys = new Set();
  try {
    const lateData = fetchLateAccountsAndFoldersByWeek(owner, repo, weekConfigs);
    lateByWeekForReport = lateData.lateByWeek;
    lateFoldersByWeekAccount = lateData.lateFoldersByWeekAccount;
    lateFetchErrorKeys = lateData.lateFetchErrorKeys ?? new Set();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!args.quiet) {
      console.log(`超时标签拉取失败，已降级为不按标签判定准时: ${msg}`);
    }
    lateByWeekForReport = new Map();
    for (const week of weekConfigs) lateByWeekForReport.set(week.id, new Set());
  }
  if (args.mode === "api") {
    log(`开始统计仓库(api): ${args.repo}`);
    const closedPrs = fetchAllPages(`/repos/${owner}/${repo}/pulls?state=closed`).sort((a, b) => a.number - b.number);
    const mergedPrs = closedPrs.filter((pr) => pr.merged_at);
    log(`已关闭 PR 数: ${closedPrs.length}, 已合并 PR 数: ${mergedPrs.length}`);
    for (const pr of mergedPrs) {
      const files = fetchAllPages(`/repos/${owner}/${repo}/pulls/${pr.number}/files`);
      const days = new Set(
        files
          .filter((f) => f.status === "added" && /\.sol$/i.test(f.filename))
          .map((f) => extractDay(path.basename(f.filename)))
          .filter((d) => Number.isInteger(d) && d >= 1 && d <= 30)
      );
      const ownerFolders = new Set(
        files
          .filter((f) => f.status === "added" && /\.sol$/i.test(f.filename))
          .map((f) => toTopLevel(f.filename))
          .filter(Boolean)
      );
      const ownerFoldersText = [...ownerFolders].sort().join(", ");
      if (days.size === 0) continue;
      const submitter = pr.user?.login ?? "";
      const createdAt = new Date(pr.created_at);
      for (const day of [...days].sort((a, b) => a - b)) {
        const week = findWeekByDay(day, weekConfigs);
        if (!week) continue;
        const deadline = new Date(week.deadlineIso);
        dayRecords.push({
          pr_number: pr.number,
          pr_url: pr.html_url,
          submitter,
          github_accounts: submitter,
          owner_folders: ownerFoldersText,
          created_at: pr.created_at,
          created_at_cn: toCnTimeText(createdAt),
          merged_at: pr.merged_at,
          merged_at_cn: toCnTimeText(new Date(pr.merged_at)),
          day,
          week: week.id,
          week_order: week.order,
          week_day_range: dayRangeText(week),
          week_deadline: week.deadlineIso,
          week_deadline_cn: toCnTimeText(deadline),
          is_late: createdAt.getTime() > deadline.getTime() ? "Y" : "N",
        });
      }
    }
  } else {
    const repoRoot = path.resolve(process.cwd(), args.repoRoot);
    log(`开始统计仓库(filesystem): ${repoRoot}`);
    const folderToGithub = loadFolderMap(args.folderMap);
    const lateByWeek = lateByWeekForReport;
    let folderDayMap = collectFolderDayMapFromLocal(repoRoot);
    if (folderDayMap.size === 0) {
      log("本地 repo-root 未扫描到有效作业，已自动回退到远程主仓库树扫描。");
      folderDayMap = collectFolderDayMapFromRemote(owner, repo);
    }
    log(`有效学员文件夹数: ${folderDayMap.size}`);
    for (const [folder, days] of folderDayMap.entries()) {
      const mapped = folderToGithub.get(folder) ? [...folderToGithub.get(folder)] : [];
      const canonicalSubmitter = mapped.length === 1 ? mapped[0] : folder;
      for (const day of days) {
        const week = findWeekByDay(day, weekConfigs);
        if (!week) continue;
        const lateAccounts = lateByWeek.get(week.id) ?? new Set();
        const candidates = mapped.length > 0 ? mapped : [folder];
        const isLate = candidates.some((x) => lateAccounts.has(x));
        dayRecords.push({
          pr_number: "",
          pr_url: "",
          submitter: canonicalSubmitter,
          github_accounts: mapped.join(", "),
          owner_folders: folder,
          created_at: "",
          created_at_cn: "",
          merged_at: "",
          merged_at_cn: "",
          day,
          week: week.id,
          week_order: week.order,
          week_day_range: dayRangeText(week),
          week_deadline: week.deadlineIso,
          week_deadline_cn: toCnTimeText(new Date(week.deadlineIso)),
          is_late: isLate ? "Y" : "N",
        });
      }
    }
  }

  const weekUserMap = new Map();
  const userDayEarliest = new Map();
  for (const row of dayRecords) {
    const wkKey = `${row.week}::${row.submitter}`;
    if (!weekUserMap.has(wkKey)) {
      weekUserMap.set(wkKey, {
        week: row.week,
        week_order: row.week_order,
        week_day_range: row.week_day_range,
        week_deadline_cn: row.week_deadline_cn,
        submitter: row.submitter,
        githubAccounts: new Set(),
        ownerFolders: new Set(),
        days: new Set(),
        prs: new Set(),
        firstCreatedAt: row.created_at,
        hasLate: false,
      });
    }
    const wk = weekUserMap.get(wkKey);
    if (row.github_accounts) {
      for (const x of String(row.github_accounts).split(",").map((s) => s.trim()).filter(Boolean)) {
        wk.githubAccounts.add(x);
      }
    }
    if (row.owner_folders) wk.ownerFolders.add(row.owner_folders);
    wk.days.add(row.day);
    wk.prs.add(row.pr_number);
    if (row.created_at < wk.firstCreatedAt) wk.firstCreatedAt = row.created_at;
    if (row.is_late === "Y") wk.hasLate = true;

    const dayKey = `${row.submitter}::${row.day}`;
    if (!userDayEarliest.has(dayKey) || row.created_at < userDayEarliest.get(dayKey).created_at) {
      userDayEarliest.set(dayKey, row);
    }
  }

  const weekSuccessRoster = [...weekUserMap.values()]
    .sort((a, b) => a.week_order - b.week_order || a.submitter.localeCompare(b.submitter))
    .map((x) => {
      const githubAccounts = [...x.githubAccounts].sort();
      const lateAccounts = lateByWeekForReport?.get(x.week) ?? new Set();
      const labelCandidates = new Set([...githubAccounts, x.submitter].filter(Boolean));
      const hasLateLabel = [...labelCandidates].some((acc) => lateAccounts.has(acc));
      const successDays = [...x.days].sort((a, b) => a - b);
      const successDaysCount = successDays.length;
      const weekDef = weekConfigById.get(x.week);
      const expectedDaysCount = weekDef ? weekDef.endDay - weekDef.startDay + 1 : 0;
      const isOntime = hasLateLabel ? "N" : "Y";
      const weekSuccess = successDaysCount >= expectedDaysCount && isOntime === "Y" ? "Y" : "N";
      return {
        week: x.week,
        week_day_range: x.week_day_range,
        week_deadline: x.week_deadline_cn,
        submitter: x.submitter,
        github_accounts: githubAccounts.join(", "),
        owner_folders: [...x.ownerFolders].sort().join(" | "),
        success_days: successDays.map((d) => `day${d}`).join(", "),
        success_days_count: successDaysCount,
        is_late: hasLateLabel ? "Y" : "N",
        is_ontime: isOntime,
        week_success: weekSuccess,
      };
    });

  const allUsers = new Set(dayRecords.map((x) => x.submitter));
  const allDays = Array.from({ length: 30 }, (_, i) => i + 1);
  const championRows = [];
  for (const user of [...allUsers].sort()) {
    const userDays = new Set();
    const lateDays = [];
    for (const day of allDays) {
      const row = userDayEarliest.get(`${user}::${day}`);
      if (!row) continue;
      userDays.add(day);
      if (row.is_late === "Y") lateDays.push(day);
    }
    const missingDays = allDays.filter((d) => !userDays.has(d));
    const weekSet = new Set();
    for (const day of userDays) {
      const wk = findWeekByDay(day, weekConfigs);
      if (wk) weekSet.add(wk.id);
    }
    const completedAllWeeks = weekSet.size === weekConfigs.length;
    const completedAllDays = missingDays.length === 0;
    const allOnTime = lateDays.length === 0;
    championRows.push({
      submitter: user,
      owner_folders: [...new Set([...userDayEarliest.values()].filter((x) => x.submitter === user).map((x) => x.owner_folders).filter(Boolean))]
        .sort()
        .join(" | "),
      completed_all_days: completedAllDays ? "Y" : "N",
      completed_all_weeks: completedAllWeeks ? "Y" : "N",
      all_days_ontime: allOnTime ? "Y" : "N",
      champion_no_late: completedAllDays && allOnTime ? "Y" : "N",
      completed_day_count: userDays.size,
      missing_days: missingDays.map((d) => `day${d}`).join(", "),
      late_days: lateDays.map((d) => `day${d}`).join(", "),
    });
  }

  const finalChampionRoster = championRows.filter((x) => x.champion_no_late === "Y");

  const summaryRows = weekConfigs.map((w) => {
    const weekRows = weekSuccessRoster.filter((x) => x.week === w.id);
    const submitterCount = weekRows.length;
    const successCount = weekRows.filter((x) => x.week_success === "Y").length;
    const ontimeCount = weekRows.filter((x) => x.week_success === "Y" && x.is_ontime === "Y").length;
    const lateCount = weekRows.filter((x) => x.success_days_count >= (w.endDay - w.startDay + 1) && x.is_late === "Y").length;
    return {
      week: w.id,
      week_day_range: dayRangeText(w),
      week_deadline: toCnTimeText(new Date(w.deadlineIso)),
      submitter_count: submitterCount,
      success_submitter_count: successCount,
      ontime_success_count: ontimeCount,
      late_success_count: lateCount,
      ontime_rate_in_success: pct(ontimeCount, successCount),
    };
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), "week_success_summary");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(weekSuccessRoster), "week_success_roster");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(finalChampionRoster), "final_no_late_champions");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(championRows), "all_submitter_progress");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dayRecords), "merged_day_records");
  if (lateByWeekForReport) {
    const lateRows = [];
    for (const week of weekConfigs) {
      const accounts = [...(lateByWeekForReport.get(week.id) ?? new Set())].sort();
      if (accounts.length === 0) {
        lateRows.push({ week: week.id, github_login: "", owner_folders: "", note: "no late accounts by label" });
      } else {
        for (const account of accounts) {
          const key = `${week.id}::${account}`;
          const foldersSet = lateFoldersByWeekAccount.get(key) ?? new Set();
          const note = lateFetchErrorKeys.has(key) ? "异常" : "";
          lateRows.push({
            week: week.id,
            github_login: account,
            owner_folders: [...foldersSet].sort().join(" | "),
            note,
          });
        }
      }
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(lateRows), "late_accounts_by_label");
  }
  XLSX.writeFile(wb, outputFile);

  if (args.quiet) {
    console.log(outputFile);
  } else {
    console.log(`统计完成，已输出: ${outputFile}`);
    console.log(`周打卡成功人数(去重按周统计): ${weekSuccessRoster.length}`);
    console.log(`全作业且全程未超时闯关人数: ${finalChampionRoster.length}`);
  }
}

main().catch((err) => {
  logGhFatalError(err);
  process.exit(1);
});

