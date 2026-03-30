#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";
import { throwOnGhFailure, logGhFatalError } from "./gh-error-format.mjs";
import { spawnGh } from "./gh-runner.mjs";
import readline from "node:readline/promises";

const DEFAULT_REPO = "0xherstory/WWW6.5";
const DAY_IN_ = /day\s*[-_ ]?\s*(\d{1,2})/i;

function parseArgs(argv) {
  const args = {
    repo: DEFAULT_REPO,
    pr: "",
    mode: "",
    comment: "",
    yes: false,
    mergeMethod: "squash",
  };
  const positionals = [];
  const supportedModes = new Set(["close", "merge", "comment", "retitle"]);
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--repo") args.repo = argv[++i] ?? args.repo;
    else if (token === "--pr") args.pr = argv[++i] ?? "";
    else if (token === "--mode") args.mode = (argv[++i] ?? "").toLowerCase();
    else if (token === "--comment") args.comment = argv[++i] ?? "";
    else if (token === "--yes") args.yes = true;
    else if (token === "--merge-method") args.mergeMethod = (argv[++i] ?? "squash").toLowerCase();
    else if (token.startsWith("--")) {
      // Ignore unknown switches to avoid hard failure.
    } else {
      positionals.push(token);
    }
  }
  // Fallback for shells/npm versions that strip option keys.
  // Supports:
  // - repo pr mode
  // - repo pr mode comment...
  // - repo pr1 pr2 ... mode comment...
  if (!args.mode && positionals.length >= 3) {
    args.repo = positionals[0] || args.repo;
    let modeIndex = -1;
    for (let i = positionals.length - 1; i >= 1; i -= 1) {
      const token = String(positionals[i]).toLowerCase();
      if (supportedModes.has(token)) {
        modeIndex = i;
        break;
      }
    }
    if (modeIndex !== -1) {
      args.mode = String(positionals[modeIndex]).toLowerCase();
      args.pr = positionals.slice(1, modeIndex).join(",");
      args.comment = positionals.slice(modeIndex + 1).join(" ");
    }
  }
  return args;
}

function parsePrList(raw) {
  return [
    ...new Set(
      String(raw)
        .split(/[,\s]+/)
        .map((x) => Number(x.trim()))
        .filter((x) => Number.isInteger(x) && x > 0)
    ),
  ];
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

function ghApi(pathAndQuery, method = "GET", body = null) {
  const args = ["api", pathAndQuery, "-X", method, "-H", "Accept: application/vnd.github+json"];
  if (body != null) {
    args.push("--input", "-");
    return runGh(args, JSON.stringify(body));
  }
  return runGh(args);
}

function validateArgs(args, prs) {
  const allowedModes = new Set(["close", "merge", "comment", "retitle"]);
  if (!allowedModes.has(args.mode)) {
    throw new Error("参数错误: --mode 仅支持 close | merge | comment | retitle");
  }
  if (prs.length === 0) {
    throw new Error("参数错误: --pr 不能为空，示例: --pr 101,102,103");
  }
  if ((args.mode === "close" || args.mode === "comment") && !args.comment.trim()) {
    throw new Error(`参数错误: mode=${args.mode} 时必须提供 --comment`);
  }
  if (args.mode === "merge" && !new Set(["merge", "squash", "rebase"]).has(args.mergeMethod)) {
    throw new Error("参数错误: --merge-method 仅支持 merge | squash | rebase");
  }
}

async function confirmIfNeeded(args, prs) {
  if (args.yes) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("\n即将批量执行：");
    console.log(`- 仓库: ${args.repo}`);
    console.log(`- PR 列表: ${prs.join(", ")}`);
    console.log(`- 模式: ${args.mode}`);
    if (args.mode === "merge") console.log(`- merge 方法: ${args.mergeMethod}`);
    if (args.comment.trim()) console.log(`- 评论内容: ${args.comment}`);
    const answer = (await rl.question("确认执行请输入 y，其他任意键取消: ")).trim().toLowerCase();
    return answer === "y";
  } finally {
    rl.close();
  }
}

function postComment(owner, repo, prNumber, comment) {
  ghApi(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, "POST", { body: comment });
}

function closePr(owner, repo, prNumber) {
  ghApi(`/repos/${owner}/${repo}/pulls/${prNumber}`, "PATCH", { state: "closed" });
}

function mergePr(owner, repo, prNumber, mergeMethod) {
  ghApi(`/repos/${owner}/${repo}/pulls/${prNumber}/merge`, "PUT", { merge_method: mergeMethod });
}

function ghApiJson(pathAndQuery, method = "GET", body = null) {
  const text = ghApi(pathAndQuery, method, body);
  return text ? JSON.parse(text) : null;
}

function extractDay(fileName) {
  const m = String(fileName).match(DAY_IN_);
  if (!m) return null;
  const day = Number(m[1]);
  if (!Number.isInteger(day) || day < 1 || day > 30) return null;
  return day;
}

function buildRuleTitle(login, dayN) {
  return `提交人${login} 挑战尝试闯关到Day${dayN}`;
}

function retitleByRule(owner, repo, prNumber) {
  const pr = ghApiJson(`/repos/${owner}/${repo}/pulls/${prNumber}`);
  const files = ghApiJson(`/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`);
  const addedSol = (Array.isArray(files) ? files : []).filter((f) => f.status === "added" && /\.sol$/i.test(f.filename));
  const days = addedSol.map((f) => extractDay(f.filename.split("/").pop() ?? f.filename)).filter((x) => Number.isInteger(x));
  if (days.length === 0) {
    throw new Error("未找到可提取 dayN 的新增 .sol 文件");
  }
  const maxDay = Math.max(...days);
  const nextTitle = buildRuleTitle(pr.user?.login ?? "", maxDay);
  if (!pr.user?.login) throw new Error("无法识别PR提交人账号名");
  ghApi(`/repos/${owner}/${repo}/pulls/${prNumber}`, "PATCH", { title: nextTitle });
  return nextTitle;
}

async function main() {
  const args = parseArgs(process.argv);
  const prs = parsePrList(args.pr);
  validateArgs(args, prs);

  const [owner, repo] = args.repo.split("/");
  if (!owner || !repo) throw new Error("参数错误: --repo 格式必须是 owner/repo");

  const confirmed = await confirmIfNeeded(args, prs);
  if (!confirmed) {
    console.log("已取消执行。");
    return;
  }

  const success = [];
  const failed = [];
  for (const prNumber of prs) {
    try {
      if (args.mode === "comment") {
        postComment(owner, repo, prNumber, args.comment);
      } else if (args.mode === "close") {
        postComment(owner, repo, prNumber, args.comment);
        closePr(owner, repo, prNumber);
      } else if (args.mode === "merge") {
        mergePr(owner, repo, prNumber, args.mergeMethod);
      } else if (args.mode === "retitle") {
        const nextTitle = retitleByRule(owner, repo, prNumber);
        console.log(`PR #${prNumber} 新标题: ${nextTitle}`);
      }
      success.push(prNumber);
      console.log(`PR #${prNumber} 执行成功`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ pr: prNumber, error: message });
      console.log(`PR #${prNumber} 执行失败: ${message}`);
    }
  }

  console.log("\n批量执行完成");
  console.log(`成功 PR: ${success.length ? success.join(", ") : "无"}`);
  if (failed.length === 0) {
    console.log("失败 PR: 无");
  } else {
    console.log("失败 PR:");
    for (const row of failed) console.log(`- #${row.pr}: ${row.error}`);
  }
}

main().catch((err) => {
  logGhFatalError(err);
  process.exit(1);
});

