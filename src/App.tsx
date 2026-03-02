import { useEffect, useMemo, useState } from "react";

type SubmitStatus = "on_time" | "late" | "missing";
type ReviewAction = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

type GitHubUser = {
  login: string;
  avatar_url: string;
  html_url: string;
};

type GitHubPull = {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: "open" | "closed";
  draft: boolean;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  head: { ref: string; sha: string };
  user: { login: string };
};

type GitHubCommit = {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author: { name: string; date: string };
  };
  author: { login: string } | null;
};

type GitHubPullFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  blob_url: string;
};

type GitHubIssueComment = { body: string };

type GitHubReview = {
  id: number;
  body: string | null;
  state: string;
  submitted_at: string | null;
  user: { login: string } | null;
};

type PullMeta = {
  day: number | null;
  reviews: GitHubReview[];
  reviewers: string[];
  reviewed: boolean;
};

type DayRecord = {
  day: number;
  submitStatus: SubmitStatus;
  submittedAt?: string;
  pr?: GitHubPull;
};

const TOTAL_DAYS = 30;
const STORAGE_TOKEN_KEY = "www65_teacher_token";
const STORAGE_REPO_KEY = "www65_repo_name";
const DEFAULT_REPO = "0xherstory/WWW6.5";
const CHALLENGE_START = new Date(`${new Date().getFullYear()}-03-01T00:00:00+08:00`);

const praiseTemplates = [
  "思路清晰，代码结构非常工整，继续保持！",
  "命名规范，注释到位，阅读体验很好。",
  "边界条件考虑完整，本题完成质量很高。",
  "实现简洁高效，体现了不错的工程习惯。",
  "提交及时且质量稳定，本周表现优秀。",
];
const errorTemplates = ["提交超时", "编译失败未通过", "不符合题目要求"];
const suggestionTemplates = [
  "建议补充测试用例，覆盖边界输入场景。",
  "可进一步优化时间复杂度，尝试减少重复计算。",
  "建议拆分函数职责，提升代码可维护性。",
  "可以补充关键步骤注释，便于后续复盘。",
  "建议统一变量命名风格，增强可读性。",
];

function normalizeComment(text: string) {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function dedupeComments(comments: string[]) {
  const picked = new Map<string, { text: string; count: number }>();
  for (const raw of comments) {
    const text = raw.trim();
    if (text.length < 6) continue;
    const key = normalizeComment(text);
    if (!key) continue;
    const old = picked.get(key);
    if (old) {
      old.count += 1;
      if (text.length > old.text.length) old.text = text;
    } else {
      picked.set(key, { text, count: 1 });
    }
  }
  return [...picked.values()]
    .sort((a, b) => b.count - a.count)
    .map((v) => v.text)
    .slice(0, 180);
}

function getWeekDeadline(day: number) {
  const week = Math.ceil(day / 7);
  const weekEndDay = Math.min(week * 7, TOTAL_DAYS);
  const deadline = new Date(CHALLENGE_START);
  deadline.setDate(CHALLENGE_START.getDate() + weekEndDay - 1);
  deadline.setHours(23, 59, 59, 999);
  return deadline;
}

function formatDate(dateString?: string | null) {
  if (!dateString) return "--";
  const d = new Date(dateString);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

function parseDay(pr: GitHubPull) {
  const source = `${pr.title} ${pr.head.ref} ${pr.body ?? ""}`;
  const match = source.match(/day\s*[-_ ]?\s*(\d{1,2})/i);
  if (!match) return null;
  const day = Number(match[1]);
  if (Number.isNaN(day) || day < 1 || day > TOTAL_DAYS) return null;
  return day;
}

function isEffectiveReview(review: GitHubReview) {
  return review.state !== "PENDING";
}

async function githubFetch<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API ${response.status}: ${text}`);
  }
  return (await response.json()) as T;
}

async function fetchAllPages<T>(token: string, pathBuilder: (page: number) => string) {
  const rows: T[] = [];
  let page = 1;
  while (true) {
    const pageRows = await githubFetch<T[]>(token, pathBuilder(page));
    rows.push(...pageRows);
    if (pageRows.length < 100) break;
    page += 1;
  }
  return rows;
}

export function App() {
  const [tokenInput, setTokenInput] = useState("");
  const [token, setToken] = useState("");
  const [repo, setRepo] = useState(DEFAULT_REPO);
  const [currentUser, setCurrentUser] = useState<GitHubUser | null>(null);
  const [pulls, setPulls] = useState<GitHubPull[]>([]);
  const [metaByPr, setMetaByPr] = useState<Record<number, PullMeta>>({});
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const [selectedPrNumber, setSelectedPrNumber] = useState<number | null>(null);
  const [draftComment, setDraftComment] = useState("");

  const [prCommits, setPrCommits] = useState<GitHubCommit[]>([]);
  const [prFiles, setPrFiles] = useState<GitHubPullFile[]>([]);
  const [prDetailLoading, setPrDetailLoading] = useState(false);
  const [prDetailError, setPrDetailError] = useState("");

  const [historyTemplates, setHistoryTemplates] = useState<string[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");

  const [owner, repoName] = repo.split("/");

  const pullsWithMeta = useMemo(
    () =>
      pulls.map((pr) => {
        const meta = metaByPr[pr.number] ?? { day: parseDay(pr), reviews: [], reviewers: [], reviewed: false };
        return { pr, meta };
      }),
    [pulls, metaByPr]
  );

  const pendingQueue = useMemo(
    () =>
      pullsWithMeta
        .filter((item) => item.pr.state === "open" && !item.meta.reviewed)
        .sort((a, b) => new Date(a.pr.created_at).getTime() - new Date(b.pr.created_at).getTime()),
    [pullsWithMeta]
  );

  const selectedItem = useMemo(() => {
    if (selectedPrNumber == null) return null;
    return pullsWithMeta.find((item) => item.pr.number === selectedPrNumber) ?? null;
  }, [selectedPrNumber, pullsWithMeta]);

  const learnerStats = useMemo(() => {
    const participants = [...new Set(pulls.map((pr) => pr.user.login))].sort((a, b) => a.localeCompare(b));
    const map = new Map<string, DayRecord[]>();
    for (const id of participants) {
      map.set(
        id,
        Array.from({ length: TOTAL_DAYS }, (_, i) => ({ day: i + 1, submitStatus: "missing" as const }))
      );
    }

    for (const { pr, meta } of pullsWithMeta) {
      if (!meta.day) continue;
      const records = map.get(pr.user.login);
      if (!records) continue;
      const idx = meta.day - 1;
      const old = records[idx].pr;
      const shouldReplace = !old || new Date(pr.created_at).getTime() < new Date(old.created_at).getTime();
      if (!shouldReplace) continue;
      records[idx] = {
        day: meta.day,
        submittedAt: pr.created_at,
        submitStatus: new Date(pr.created_at).getTime() <= getWeekDeadline(meta.day).getTime() ? "on_time" : "late",
        pr,
      };
    }

    const rows = participants.map((github) => {
      const dayRecords = map.get(github) ?? [];
      const onTime = dayRecords.filter((d) => d.submitStatus === "on_time").length;
      const late = dayRecords.filter((d) => d.submitStatus === "late").length;
      const missing = dayRecords.filter((d) => d.submitStatus === "missing").length;
      const pass30 = onTime === TOTAL_DAYS;
      return { github, dayRecords, onTime, late, missing, pass30 };
    });

    const weekly = Array.from({ length: Math.ceil(TOTAL_DAYS / 7) }, (_, i) => {
      const start = i * 7 + 1;
      const end = Math.min((i + 1) * 7, TOTAL_DAYS);
      const passCount = rows.filter((row) =>
        row.dayRecords.filter((r) => r.day >= start && r.day <= end).every((r) => r.submitStatus === "on_time")
      ).length;
      return {
        week: i + 1,
        start,
        end,
        passCount,
        rate: rows.length === 0 ? 0 : Math.round((passCount / rows.length) * 100),
      };
    });

    const passers = rows.filter((r) => r.pass30);
    return {
      participants,
      rows,
      weekly,
      passers,
      pass30Rate: rows.length === 0 ? 0 : Math.round((passers.length / rows.length) * 100),
      unresolvedDayPRs: pullsWithMeta.filter((item) => !item.meta.day).length,
    };
  }, [pulls, pullsWithMeta]);

  const teacherStats = useMemo(() => {
    const reviewCountMap = new Map<string, number>();
    const myReviewedPRs: GitHubPull[] = [];

    for (const item of pullsWithMeta) {
      const reviewers = new Set<string>();
      for (const review of item.meta.reviews) {
        if (!isEffectiveReview(review)) continue;
        const login = review.user?.login;
        if (!login) continue;
        reviewCountMap.set(login, (reviewCountMap.get(login) ?? 0) + 1);
        reviewers.add(login);
      }
      if (currentUser && reviewers.has(currentUser.login)) myReviewedPRs.push(item.pr);
    }

    const teacherRows = [...reviewCountMap.entries()]
      .map(([login, count]) => ({ login, count }))
      .sort((a, b) => b.count - a.count);
    const processed = pullsWithMeta.filter((item) => item.meta.reviewed).length;
    return { teacherRows, processed, pending: pendingQueue.length, myReviewedPRs };
  }, [pullsWithMeta, currentUser, pendingQueue.length]);

  async function loadHistoricalTemplates(authToken: string, repoOwner: string, repoInner: string, allPulls: GitHubPull[]) {
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const [issueComments, reviewComments] = await Promise.all([
        fetchAllPages<GitHubIssueComment>(
          authToken,
          (page) => `/repos/${repoOwner}/${repoInner}/issues/comments?per_page=100&page=${page}&sort=updated&direction=desc`
        ),
        fetchAllPages<GitHubIssueComment>(
          authToken,
          (page) => `/repos/${repoOwner}/${repoInner}/pulls/comments?per_page=100&page=${page}&sort=updated&direction=desc`
        ),
      ]);

      const reviewBodies: string[] = [];
      const scan = allPulls.slice(0, 80);
      for (let i = 0; i < scan.length; i += 8) {
        const batch = scan.slice(i, i + 8);
        const rows = await Promise.allSettled(
          batch.map((pr) => githubFetch<GitHubReview[]>(authToken, `/repos/${repoOwner}/${repoInner}/pulls/${pr.number}/reviews?per_page=100`))
        );
        rows.forEach((r) => {
          if (r.status === "fulfilled") {
            r.value.forEach((x) => {
              if (x.body?.trim()) reviewBodies.push(x.body.trim());
            });
          }
        });
      }

      setHistoryTemplates(dedupeComments([...issueComments.map((x) => x.body), ...reviewComments.map((x) => x.body), ...reviewBodies]));
    } finally {
      setHistoryLoading(false);
    }
  }

  async function loadDashboard(authToken: string, targetRepo: string) {
    const [repoOwner, repoInner] = targetRepo.split("/");
    if (!repoOwner || !repoInner) throw new Error("仓库格式错误，请使用 owner/repo");

    setLoading(true);
    setError("");
    try {
      const user = await githubFetch<GitHubUser>(authToken, "/user");
      const allPulls = await fetchAllPages<GitHubPull>(
        authToken,
        (page) => `/repos/${repoOwner}/${repoInner}/pulls?state=all&per_page=100&page=${page}&sort=created&direction=desc`
      );

      const meta: Record<number, PullMeta> = {};
      for (let i = 0; i < allPulls.length; i += 8) {
        const batch = allPulls.slice(i, i + 8);
        const rows = await Promise.allSettled(
          batch.map((pr) => githubFetch<GitHubReview[]>(authToken, `/repos/${repoOwner}/${repoInner}/pulls/${pr.number}/reviews?per_page=100`))
        );
        rows.forEach((row, idx) => {
          const pr = batch[idx];
          const reviews = row.status === "fulfilled" ? row.value : [];
          const effective = reviews.filter(isEffectiveReview);
          meta[pr.number] = {
            day: parseDay(pr),
            reviews,
            reviewers: [...new Set(effective.map((r) => r.user?.login).filter(Boolean) as string[])],
            reviewed: effective.length > 0,
          };
        });
      }

      setCurrentUser(user);
      setPulls(allPulls);
      setMetaByPr(meta);

      const firstPending = allPulls.find((pr) => pr.state === "open" && !meta[pr.number]?.reviewed);
      setSelectedPrNumber(firstPending ? firstPending.number : allPulls[0]?.number ?? null);

      loadHistoricalTemplates(authToken, repoOwner, repoInner, allPulls).catch((e: unknown) => {
        setHistoryError(e instanceof Error ? e.message : "历史批注加载失败");
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const savedToken = localStorage.getItem(STORAGE_TOKEN_KEY);
    const savedRepo = localStorage.getItem(STORAGE_REPO_KEY) || DEFAULT_REPO;
    setRepo(savedRepo);
    if (!savedToken) return;

    setToken(savedToken);
    setTokenInput(savedToken);
    loadDashboard(savedToken, savedRepo).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : "登录失败");
      localStorage.removeItem(STORAGE_TOKEN_KEY);
      setToken("");
    });
  }, []);

  useEffect(() => {
    if (!selectedItem || !token || !owner || !repoName) {
      setPrCommits([]);
      setPrFiles([]);
      return;
    }

    let ignore = false;
    setPrDetailLoading(true);
    setPrDetailError("");

    Promise.all([
      fetchAllPages<GitHubCommit>(
        token,
        (page) => `/repos/${owner}/${repoName}/pulls/${selectedItem.pr.number}/commits?per_page=100&page=${page}`
      ),
      fetchAllPages<GitHubPullFile>(
        token,
        (page) => `/repos/${owner}/${repoName}/pulls/${selectedItem.pr.number}/files?per_page=100&page=${page}`
      ),
    ])
      .then(([commits, files]) => {
        if (ignore) return;
        setPrCommits(commits);
        setPrFiles(files);
      })
      .catch((e: unknown) => {
        if (ignore) return;
        setPrDetailError(e instanceof Error ? e.message : "PR 详情加载失败");
        setPrCommits([]);
        setPrFiles([]);
      })
      .finally(() => {
        if (!ignore) setPrDetailLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, [selectedItem?.pr.number, token, owner, repoName]);

  async function handleLogin() {
    if (!tokenInput.trim()) {
      setError("请先填写 GitHub Token（页面下方有新手获取 Token 指引）");
      return;
    }

    try {
      await loadDashboard(tokenInput.trim(), repo.trim());
      setToken(tokenInput.trim());
      localStorage.setItem(STORAGE_TOKEN_KEY, tokenInput.trim());
      localStorage.setItem(STORAGE_REPO_KEY, repo.trim());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "登录失败");
    }
  }

  function handleLogout() {
    localStorage.removeItem(STORAGE_TOKEN_KEY);
    setToken("");
    setCurrentUser(null);
    setPulls([]);
    setMetaByPr({});
    setSelectedPrNumber(null);
    setDraftComment("");
    setError("");
  }

  function appendTemplateToComment(snippet: string) {
    const text = snippet.trim();
    if (!text) return;
    setDraftComment((prev) => (prev.trim() ? `${prev.trim()}\n${text}` : text));
  }

  async function submitReview(action: ReviewAction) {
    if (!selectedItem || !token || !owner || !repoName) return;

    setSubmitting(true);
    setError("");
    try {
      await githubFetch(token, `/repos/${owner}/${repoName}/pulls/${selectedItem.pr.number}/reviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: action,
          body: draftComment.trim() || "老师已完成本次批改。",
        }),
      });
      setDraftComment("");
      await loadDashboard(token, repo);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "提交批注失败";
      if (message.includes("422")) {
        setError("提交失败：该 PR 可能刚被其他老师处理，请刷新后重试。");
      } else {
        setError(message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen px-4 py-6 text-[var(--text-strong)] sm:px-6 lg:px-10">
      <div className="mx-auto max-w-7xl space-y-5">
        <header className="rounded-3xl border border-[var(--line)] bg-[var(--card)]/95 p-5 shadow-[0_20px_60px_-35px_rgba(15,23,32,0.45)]">
          <div className="grid gap-4 md:grid-cols-[1.5fr_1fr]">
            <div>
              <p className="inline-flex rounded-full border border-amber-300 bg-amber-100 px-3 py-1 text-xs font-bold text-amber-900">Teacher Collaboration Console</p>
              <h1 className="mt-2 text-3xl font-bold">WWW6.5 教师协作批改台</h1>
              <p className="mt-2 text-sm text-[var(--text-soft)]">学员打卡统计与老师批改统计已分开展示。待批改仅包含“没有任何批改记录”的 Open PR。</p>
            </div>
            <div className="rounded-2xl border border-[var(--line)] bg-white/80 p-4">
              <input value={repo} onChange={(e) => setRepo(e.target.value)} className="w-full rounded-xl border border-[var(--line)] bg-white px-3 py-2 text-sm" placeholder="owner/repo" />
              <p className="mt-2 text-sm">状态：{currentUser ? `已连接 @${currentUser.login}` : "未登录"}</p>
              <input
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                type="password"
                className="mt-2 w-full rounded-xl border border-[var(--line)] bg-white px-3 py-2 text-sm"
                placeholder="粘贴 ghp_ 开头的 classic token"
              />
              <div className="mt-2 flex gap-2">
                <button onClick={handleLogin} disabled={loading} className="flex-1 rounded-xl bg-[var(--bg-ink)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">
                  {loading ? "同步中..." : "登录并同步"}
                </button>
                <button onClick={handleLogout} className="rounded-xl border border-[var(--line)] bg-white px-3 py-2 text-sm font-semibold">退出</button>
              </div>
              <button
                onClick={() => {
                  if (!token) return;
                  loadDashboard(token, repo).catch((e: unknown) => setError(e instanceof Error ? e.message : "刷新失败"));
                }}
                disabled={!token || loading}
                className="mt-2 w-full rounded-xl border border-[var(--line)] bg-white px-3 py-2 text-xs font-semibold disabled:opacity-60"
              >
                手动刷新全量数据
              </button>
            </div>
          </div>
          <details className="mt-3 rounded-xl border border-[var(--line)] bg-white/70 p-3 text-xs">
            <summary className="cursor-pointer font-bold">新手获取 Token 指引（推荐 Classic Token）</summary>
            <ol className="mt-2 list-decimal space-y-1 pl-4">
              <li>打开 https://github.com/settings/tokens</li>
              <li>进入 Tokens (classic)，点击 Generate new token (classic)</li>
              <li>Note 随便填，Expiration 选 30 或 90 天</li>
              <li>勾选 repo 权限</li>
              <li>生成后复制 token，粘贴到上方登录</li>
            </ol>
          </details>
          {error ? <p className="mt-3 rounded-xl border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p> : null}
        </header>

        <main className="grid gap-4 lg:grid-cols-[1fr_1.5fr_1.2fr]">
          <section className="rounded-3xl border border-[var(--line)] bg-[var(--card)]/95 p-4">
            <h2 className="text-lg font-bold">待批改 PR（无批改记录）</h2>
            <p className="text-xs text-[var(--text-soft)]">任何老师处理后会自动移出待办。</p>
            <div className="mt-3 space-y-2">
              {pendingQueue.map((item) => (
                <button
                  key={item.pr.number}
                  onClick={() => {
                    setSelectedPrNumber(item.pr.number);
                    setDraftComment("");
                  }}
                  className={`w-full rounded-xl border p-3 text-left ${selectedPrNumber === item.pr.number ? "border-amber-400 bg-amber-50" : "border-[var(--line)] bg-white"}`}
                >
                  <p className="text-sm font-bold">#{item.pr.number} @{item.pr.user.login}</p>
                  <p className="mt-1 text-xs text-[var(--text-soft)]">{item.meta.day ? `Day ${item.meta.day}` : "未识别 Day"} · {formatDate(item.pr.created_at)}</p>
                </button>
              ))}
              {pendingQueue.length === 0 ? <p className="text-sm text-[var(--text-soft)]">暂无待批改 PR。</p> : null}
            </div>
          </section>

          <section className="rounded-3xl border border-[var(--line)] bg-[var(--card)]/95 p-4">
            {!selectedItem ? (
              <p className="text-sm text-[var(--text-soft)]">请选择左侧待批改 PR，或在右侧历史列表中点选任意 PR。</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] pb-3">
                  <h2 className="text-lg font-bold">#{selectedItem.pr.number} @{selectedItem.pr.user.login}</h2>
                  <span className={`rounded-full px-2 py-1 text-xs font-bold ${selectedItem.meta.reviewed ? "bg-emerald-100 text-emerald-800" : "bg-orange-100 text-orange-800"}`}>
                    {selectedItem.meta.reviewed ? "已批改" : "待批改"}
                  </span>
                </div>
                <p className="mt-2 text-xs text-[var(--text-soft)]">{selectedItem.meta.day ? `Day ${selectedItem.meta.day}` : "未识别 Day"} · 创建于 {formatDate(selectedItem.pr.created_at)}</p>
                <a className="mt-1 block break-all text-xs text-sky-700 underline" href={selectedItem.pr.html_url} target="_blank" rel="noreferrer">
                  {selectedItem.pr.html_url}
                </a>
                <p className="mt-1 text-xs text-[var(--text-soft)]">批改老师：{selectedItem.meta.reviewers.length > 0 ? selectedItem.meta.reviewers.map((x) => `@${x}`).join(", ") : "暂无"}</p>

                <div className="mt-3 rounded-xl border border-[var(--line)] bg-white/85 p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-bold">Commit 列表</p>
                    <span className="text-xs text-[var(--text-soft)]">{prCommits.length} 个</span>
                  </div>
                  {prDetailLoading ? <p className="mt-2 text-xs text-[var(--text-soft)]">正在加载详情...</p> : null}
                  {prDetailError ? <p className="mt-2 text-xs text-rose-700">{prDetailError}</p> : null}
                  <div className="mt-2 max-h-44 space-y-2 overflow-auto">
                    {prCommits.map((commit) => (
                      <div key={commit.sha} className="rounded-lg border border-[var(--line)] bg-[var(--bg-paper)]/70 p-2">
                        <a href={commit.html_url} target="_blank" rel="noreferrer" className="text-xs font-semibold text-sky-700 underline">{commit.sha.slice(0, 7)}</a>
                        <p className="text-xs">{commit.commit.message.split("\n")[0]}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="mt-3 rounded-xl border border-[var(--line)] bg-white/85 p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-bold">代码改动内容</p>
                    <span className="text-xs text-[var(--text-soft)]">{prFiles.length} 个文件</span>
                  </div>
                  <div className="mt-2 max-h-[320px] space-y-2 overflow-auto">
                    {prFiles.map((file) => (
                      <div key={file.filename} className="rounded-lg border border-[var(--line)] bg-[var(--bg-paper)]/60 p-2">
                        <a href={file.blob_url} target="_blank" rel="noreferrer" className="text-xs font-semibold text-sky-700 underline">{file.filename}</a>
                        <p className="text-[11px] text-[var(--text-soft)]">{file.status} · +{file.additions} / -{file.deletions}</p>
                        {file.patch ? (
                          <pre className="mt-1 overflow-x-auto rounded-md bg-[#101b24] p-2 text-[10px] text-slate-100"><code>{file.patch}</code></pre>
                        ) : (
                          <p className="mt-1 text-[11px] text-[var(--text-soft)]">大文件或二进制文件，API 未提供 patch。</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="mt-3 rounded-xl border border-[var(--line)] bg-white/85 p-3">
                  <p className="text-sm font-bold">快捷批注</p>
                  <div className="mt-2 grid gap-2 md:grid-cols-3">
                    <label className="rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-xs">
                      绿色：好评
                      <select
                        defaultValue=""
                        className="mt-1 w-full rounded border border-emerald-300 bg-white p-1"
                        onChange={(e) => {
                          appendTemplateToComment(e.target.value);
                          e.target.value = "";
                        }}
                      >
                        <option value="">请选择</option>
                        {praiseTemplates.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="rounded-lg border border-rose-200 bg-rose-50 p-2 text-xs">
                      红色：错误
                      <select
                        defaultValue=""
                        className="mt-1 w-full rounded border border-rose-300 bg-white p-1"
                        onChange={(e) => {
                          appendTemplateToComment(e.target.value);
                          e.target.value = "";
                        }}
                      >
                        <option value="">请选择</option>
                        {errorTemplates.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="rounded-lg border border-sky-200 bg-sky-50 p-2 text-xs">
                      蓝色：建议
                      <select
                        defaultValue=""
                        className="mt-1 w-full rounded border border-sky-300 bg-white p-1"
                        onChange={(e) => {
                          appendTemplateToComment(e.target.value);
                          e.target.value = "";
                        }}
                      >
                        <option value="">请选择</option>
                        {suggestionTemplates.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs md:col-span-3">
                      历史批注参考（去重）
                      <div className="mt-1 flex items-center gap-2">
                        <select
                          defaultValue=""
                          className="w-full rounded border border-slate-300 bg-white p-1"
                          onChange={(e) => {
                            appendTemplateToComment(e.target.value);
                            e.target.value = "";
                          }}
                        >
                          <option value="">请选择历史批注</option>
                          {historyTemplates.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => {
                            if (!token || !owner || !repoName) return;
                            loadHistoricalTemplates(token, owner, repoName, pulls).catch((e: unknown) => {
                              setHistoryError(e instanceof Error ? e.message : "刷新历史批注失败");
                            });
                          }}
                          className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold"
                        >
                          {historyLoading ? "加载中" : "刷新"}
                        </button>
                      </div>
                      {historyError ? <p className="mt-1 text-[11px] text-rose-700">{historyError}</p> : null}
                    </label>
                  </div>

                  <textarea value={draftComment} onChange={(e) => setDraftComment(e.target.value)} className="mt-2 h-28 w-full rounded-xl border border-[var(--line)] bg-white p-2 text-sm" placeholder="输入批注" />
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button onClick={() => submitReview("APPROVE")} disabled={submitting} className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60">批注并通过</button>
                    <button onClick={() => submitReview("REQUEST_CHANGES")} disabled={submitting} className="rounded-lg bg-orange-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60">请求修改</button>
                    <button onClick={() => submitReview("COMMENT")} disabled={submitting} className="rounded-lg bg-sky-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60">仅评论</button>
                  </div>
                </div>
              </>
            )}
          </section>

          <section className="space-y-3 rounded-3xl border border-[var(--line)] bg-[var(--card)]/95 p-4">
            <div className="rounded-2xl border border-[var(--line)] bg-white/85 p-3">
              <h3 className="text-sm font-bold">运营总览</h3>
              <p className="mt-1 text-xs">历史总 PR：<b>{pulls.length}</b></p>
              <p className="text-xs">启动挑战学员（提交过 PR）：<b>{learnerStats.participants.length}</b></p>
            </div>

            <div className="rounded-2xl border border-[var(--line)] bg-white/85 p-3">
              <h3 className="text-sm font-bold">学员打卡统计（与批改分离）</h3>
              <p className="mt-1 text-xs">30 天最终通关率：<b>{learnerStats.pass30Rate}%</b></p>
              <p className="text-[11px] text-[var(--text-soft)]">未识别 Day 的 PR：{learnerStats.unresolvedDayPRs}</p>
              <div className="mt-2 space-y-1 text-xs">
                {learnerStats.weekly.map((w) => (
                  <div key={w.week} className="rounded-md bg-[var(--bg-paper)]/70 px-2 py-1">
                    第{w.week}周 Day{w.start}-{w.end}: {w.passCount}/{learnerStats.rows.length || 1} ({w.rate}%)
                  </div>
                ))}
              </div>
              <div className="mt-2 max-h-36 space-y-1 overflow-auto text-xs">
                {learnerStats.rows.map((row) => (
                  <div key={row.github} className="rounded-md border border-[var(--line)] px-2 py-1">
                    @{row.github} · 准时 {row.onTime} / 逾期 {row.late} / 缺交 {row.missing}
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-[var(--line)] bg-white/85 p-3">
              <h3 className="text-sm font-bold">老师批改统计（协作工作量）</h3>
              <p className="mt-1 text-xs">待批改（未处理）PR：<b>{teacherStats.pending}</b></p>
              <p className="text-xs">已处理 PR：<b>{teacherStats.processed}</b></p>
              <div className="mt-2 max-h-28 space-y-1 overflow-auto text-xs">
                {teacherStats.teacherRows.map((t) => (
                  <p key={t.login} className="rounded-md bg-[var(--bg-paper)]/70 px-2 py-1">@{t.login}：{t.count} 次批改</p>
                ))}
                {teacherStats.teacherRows.length === 0 ? <p className="text-[var(--text-soft)]">暂无批改记录。</p> : null}
              </div>
              <p className="mt-2 text-xs font-semibold">我（@{currentUser?.login || "--"}）批改过的 PR</p>
              <div className="mt-1 max-h-28 space-y-1 overflow-auto text-xs">
                {teacherStats.myReviewedPRs.map((pr) => (
                  <button key={pr.number} className="block w-full rounded-md border border-[var(--line)] px-2 py-1 text-left hover:bg-amber-50" onClick={() => setSelectedPrNumber(pr.number)}>
                    #{pr.number} @{pr.user.login}
                  </button>
                ))}
                {teacherStats.myReviewedPRs.length === 0 ? <p className="text-[var(--text-soft)]">暂无。</p> : null}
              </div>
            </div>

            <div className="rounded-2xl border border-[var(--line)] bg-white/85 p-3">
              <h3 className="text-sm font-bold">历史 PR（含批改状态）</h3>
              <div className="mt-2 max-h-56 space-y-1 overflow-auto text-xs">
                {pullsWithMeta.map((item) => (
                  <button key={item.pr.number} onClick={() => setSelectedPrNumber(item.pr.number)} className="w-full rounded-md border border-[var(--line)] px-2 py-1 text-left hover:bg-amber-50">
                    <div className="flex items-center justify-between gap-2">
                      <span>#{item.pr.number} @{item.pr.user.login}</span>
                      <span className={`rounded-full px-2 py-0.5 ${item.meta.reviewed ? "bg-emerald-100 text-emerald-800" : "bg-orange-100 text-orange-800"}`}>
                        {item.meta.reviewed ? "已批改" : "待批改"}
                      </span>
                    </div>
                    <p className="truncate text-[11px] text-[var(--text-soft)]">老师：{item.meta.reviewers.length > 0 ? item.meta.reviewers.map((x) => `@${x}`).join(", ") : "--"}</p>
                  </button>
                ))}
              </div>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}