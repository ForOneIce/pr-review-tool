import { useEffect, useMemo, useState } from "react";

type SubmitStatus = "on_time" | "late" | "missing";
type ReviewAction = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

type GitHubUser = { login: string; avatar_url: string; html_url: string };
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
  commit: { message: string; author: { name: string; date: string } };
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
  latestReviewedAt: string | null;
  mergedBy: string | null;
};
type DayRecord = {
  day: number;
  submitStatus: SubmitStatus;
  submittedAt?: string;
  pr?: GitHubPull;
};
type GitHubIssueEvent = {
  event: string;
  created_at?: string;
  actor?: { login: string } | null;
};

const TOTAL_DAYS = 30;
const STORAGE_TOKEN_KEY = "www65_teacher_token";
const STORAGE_REPO_KEY = "www65_repo_name";
const DEFAULT_REPO = "0xherstory/WWW6.5";
const CHALLENGE_START = new Date(`${new Date().getFullYear()}-03-01T00:00:00+08:00`);

const praiseTemplates = ["思路清晰，代码结构非常工整，继续保持！", "命名规范，注释到位，阅读体验很好。", "边界条件考虑完整，本题完成质量很高。", "实现简洁高效，体现了不错的工程习惯。", "提交及时且质量稳定，本周表现优秀。"];
const errorTemplates = ["提交超时", "编译失败未通过", "不符合题目要求", "空文件", "代码与标题内容不符", "改动冲突", "修改了其他人的文件结构"];
const suggestionTemplates = ["建议补充测试用例，覆盖边界输入场景。", "可进一步优化时间复杂度，尝试减少重复计算。", "建议拆分函数职责，提升代码可维护性。", "可以补充关键步骤注释，便于后续复盘。", "建议统一变量命名风格，增强可读性。"];
const reviewActionTips: Record<ReviewAction, string> = {
  APPROVE: "批注并通过：会提交 Review 并标记为 Approve，表示本次作业评审通过。",
  REQUEST_CHANGES: "请求修改：会提交 Review 并要求学员修改后再看，PR 会显示 changes requested。",
  COMMENT: "仅评论：只留下评语，不改变通过/请求修改状态，适合补充建议或追问。",
};

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
  return [...picked.values()].sort((a, b) => b.count - a.count).map((v) => v.text).slice(0, 180);
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
function latestReviewAt(reviews: GitHubReview[]) {
  const effective = reviews.filter(isEffectiveReview).filter((r) => r.submitted_at);
  if (effective.length === 0) return null;
  return effective.sort((a, b) => new Date(b.submitted_at as string).getTime() - new Date(a.submitted_at as string).getTime())[0].submitted_at;
}
function toReadableCodePreview(patch?: string) {
  if (!patch) return "";
  const lines = patch.split("\n");
  const cleaned: string[] = [];
  for (const line of lines) {
    if (line.startsWith("@@") || line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("+")) {
      cleaned.push(line.slice(1));
      continue;
    }
    if (line.startsWith(" ")) {
      cleaned.push(line.slice(1));
      continue;
    }
  }
  return cleaned.join("\n").trim();
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
async function fetchMergedBy(token: string, owner: string, repo: string, prNumber: number) {
  const events = await fetchAllPages<GitHubIssueEvent>(token, (page) => `/repos/${owner}/${repo}/issues/${prNumber}/events?per_page=100&page=${page}`);
  const mergedEvents = events.filter((event) => event.event === "merged" && event.actor?.login);
  if (mergedEvents.length === 0) return null;
  mergedEvents.sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime());
  return mergedEvents[0].actor?.login ?? null;
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
  const [selectedLearner, setSelectedLearner] = useState<string | null>(null);
  const [draftComment, setDraftComment] = useState("");

  const [prCommits, setPrCommits] = useState<GitHubCommit[]>([]);
  const [prFiles, setPrFiles] = useState<GitHubPullFile[]>([]);
  const [prDetailLoading, setPrDetailLoading] = useState(false);
  const [prDetailError, setPrDetailError] = useState("");
  const [copiedFile, setCopiedFile] = useState("");

  const [historyTemplates, setHistoryTemplates] = useState<string[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");

  const [owner, repoName] = repo.split("/");

  const pullsWithMeta = useMemo(
    () => pulls.map((pr) => ({ pr, meta: metaByPr[pr.number] ?? { day: parseDay(pr), reviews: [], reviewers: [], reviewed: false, latestReviewedAt: null, mergedBy: null } })),
    [pulls, metaByPr]
  );

  const selectedItem = useMemo(() => (selectedPrNumber == null ? null : pullsWithMeta.find((item) => item.pr.number === selectedPrNumber) ?? null), [selectedPrNumber, pullsWithMeta]);

  const teacherStats = useMemo(() => {
    const reviewCountMap = new Map<string, number>();
    const contributionMap = new Map<
      string,
      { total: number; reviewTotal: number; mergeTotal: number; approve: number; requestChanges: number; comment: number; prs: Set<number>; mergedPrs: Set<number> }
    >();
    const pendingQueue = pullsWithMeta.filter((item) => item.pr.state === "open" && !item.meta.reviewed).sort((a, b) => new Date(a.pr.created_at).getTime() - new Date(b.pr.created_at).getTime());
    const historyList = [...pullsWithMeta].sort((a, b) => new Date(b.pr.created_at).getTime() - new Date(a.pr.created_at).getTime());
    const reviewedCount = pullsWithMeta.filter((item) => item.meta.reviewed).length;
    const mergedCount = pullsWithMeta.filter((item) => item.pr.merged_at).length;

    const myReviewedUnmerged: Array<{ item: (typeof pullsWithMeta)[number]; at: string }> = [];
    const myReviewedMerged: Array<{ item: (typeof pullsWithMeta)[number]; at: string }> = [];

    for (const item of pullsWithMeta) {
      const effective = item.meta.reviews.filter(isEffectiveReview);
      for (const review of effective) {
        const login = review.user?.login;
        if (!login) continue;
        reviewCountMap.set(login, (reviewCountMap.get(login) ?? 0) + 1);

        const row = contributionMap.get(login) ?? {
          total: 0,
          reviewTotal: 0,
          mergeTotal: 0,
          approve: 0,
          requestChanges: 0,
          comment: 0,
          prs: new Set<number>(),
          mergedPrs: new Set<number>(),
        };
        row.total += 1;
        row.reviewTotal += 1;
        row.prs.add(item.pr.number);
        if (item.pr.merged_at) row.mergedPrs.add(item.pr.number);
        if (review.state === "APPROVED") row.approve += 1;
        else if (review.state === "CHANGES_REQUESTED") row.requestChanges += 1;
        else row.comment += 1;
        contributionMap.set(login, row);
      }
      if (item.pr.merged_at && item.meta.mergedBy) {
        const mergedBy = item.meta.mergedBy;
        const row = contributionMap.get(mergedBy) ?? {
          total: 0,
          reviewTotal: 0,
          mergeTotal: 0,
          approve: 0,
          requestChanges: 0,
          comment: 0,
          prs: new Set<number>(),
          mergedPrs: new Set<number>(),
        };
        row.total += 1;
        row.mergeTotal += 1;
        row.prs.add(item.pr.number);
        row.mergedPrs.add(item.pr.number);
        contributionMap.set(mergedBy, row);
      }
      if (!currentUser) continue;
      const mine = effective.filter((r) => r.user?.login === currentUser.login && r.submitted_at).sort((a, b) => new Date(b.submitted_at as string).getTime() - new Date(a.submitted_at as string).getTime());
      if (mine.length === 0) continue;
      const latest = mine[0].submitted_at as string;
      if (item.pr.merged_at) {
        myReviewedMerged.push({ item, at: item.pr.merged_at });
      } else {
        myReviewedUnmerged.push({ item, at: latest });
      }
    }

    const teacherRows = [...reviewCountMap.entries()].map(([login, count]) => ({ login, count })).sort((a, b) => b.count - a.count);
    const contributionRows = [...contributionMap.entries()]
      .map(([login, row]) => ({
        login,
        total: row.total,
        reviewTotal: row.reviewTotal,
        mergeTotal: row.mergeTotal,
        approve: row.approve,
        requestChanges: row.requestChanges,
        comment: row.comment,
        coveredPrs: row.prs.size,
        mergedFollowUps: row.mergedPrs.size,
      }))
      .sort((a, b) => b.total - a.total || b.coveredPrs - a.coveredPrs);
    myReviewedUnmerged.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    myReviewedMerged.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    return { pendingQueue, historyList, reviewedCount, mergedCount, teacherRows, contributionRows, myReviewedUnmerged, myReviewedMerged };
  }, [pullsWithMeta, currentUser]);

  const learnerStats = useMemo(() => {
    const participants = [...new Set(pulls.map((pr) => pr.user.login))].sort((a, b) => a.localeCompare(b));
    const dayMap = new Map<string, DayRecord[]>();
    for (const user of participants) dayMap.set(user, Array.from({ length: TOTAL_DAYS }, (_, i) => ({ day: i + 1, submitStatus: "missing" as const })));

    for (const { pr, meta } of pullsWithMeta) {
      if (!meta.day) continue;
      const records = dayMap.get(pr.user.login);
      if (!records) continue;
      const idx = meta.day - 1;
      const old = records[idx].pr;
      const shouldReplace = !old || new Date(pr.created_at).getTime() < new Date(old.created_at).getTime();
      if (!shouldReplace) continue;
      records[idx] = { day: meta.day, submitStatus: new Date(pr.created_at).getTime() <= getWeekDeadline(meta.day).getTime() ? "on_time" : "late", submittedAt: pr.created_at, pr };
    }

    const rows = participants.map((github) => {
      const dayRecords = dayMap.get(github) ?? [];
      const userPulls = pullsWithMeta.filter((item) => item.pr.user.login === github).sort((a, b) => new Date(b.pr.created_at).getTime() - new Date(a.pr.created_at).getTime());
      let challengeDay = 0;
      for (const rec of dayRecords) {
        if (rec.submitStatus === "on_time") challengeDay = rec.day;
        else break;
      }
      const onTime = dayRecords.filter((d) => d.submitStatus === "on_time").length;
      const late = dayRecords.filter((d) => d.submitStatus === "late").length;
      const missing = dayRecords.filter((d) => d.submitStatus === "missing").length;
      return {
        github,
        dayRecords,
        onTime,
        late,
        missing,
        challengeDay,
        finalPass: onTime === TOTAL_DAYS,
        submissionCount: userPulls.length,
        reviewedCount: userPulls.filter((x) => x.meta.reviewed).length,
        mergedCount: userPulls.filter((x) => Boolean(x.pr.merged_at)).length,
        unreviewedCount: userPulls.filter((x) => !x.meta.reviewed).length,
        pulls: userPulls,
      };
    });

    const weekly = Array.from({ length: Math.ceil(TOTAL_DAYS / 7) }, (_, i) => {
      const start = i * 7 + 1;
      const end = Math.min((i + 1) * 7, TOTAL_DAYS);
      const passCount = rows.filter((row) => row.dayRecords.filter((r) => r.day >= start && r.day <= end).every((r) => r.submitStatus === "on_time")).length;
      return { week: i + 1, start, end, passCount, rate: rows.length ? Math.round((passCount / rows.length) * 100) : 0 };
    });

    const daily = Array.from({ length: TOTAL_DAYS }, (_, i) => {
      const day = i + 1;
      const successCount = rows.filter((row) => row.dayRecords[i]?.submitStatus === "on_time").length;
      return {
        day,
        successCount,
        rate: rows.length ? Math.round((successCount / rows.length) * 100) : 0,
      };
    });

    const passers = rows.filter((r) => r.finalPass);
    return {
      participants,
      rows,
      weekly,
      daily,
      finalPassRate: rows.length ? Math.round((passers.length / rows.length) * 100) : 0,
      unresolvedDayPRs: pullsWithMeta.filter((item) => !item.meta.day).length,
      starters: participants.length,
      totalPrs: pulls.length,
      passers,
    };
  }, [pulls, pullsWithMeta]);

  const selectedLearnerRow = useMemo(() => (selectedLearner ? learnerStats.rows.find((r) => r.github === selectedLearner) ?? null : null), [selectedLearner, learnerStats.rows]);

  async function copyText(text: string, filename: string) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedFile(filename);
      window.setTimeout(() => setCopiedFile(""), 1500);
    } catch {
      setError("复制失败，请检查浏览器是否允许剪贴板权限。");
    }
  }

  async function loadHistoricalTemplates(authToken: string, repoOwner: string, repoInner: string, allPulls: GitHubPull[]) {
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const [issueComments, reviewComments] = await Promise.all([
        fetchAllPages<GitHubIssueComment>(authToken, (page) => `/repos/${repoOwner}/${repoInner}/issues/comments?per_page=100&page=${page}&sort=updated&direction=desc`),
        fetchAllPages<GitHubIssueComment>(authToken, (page) => `/repos/${repoOwner}/${repoInner}/pulls/comments?per_page=100&page=${page}&sort=updated&direction=desc`),
      ]);
      const reviewBodies: string[] = [];
      const scan = allPulls.slice(0, 80);
      for (let i = 0; i < scan.length; i += 8) {
        const batch = scan.slice(i, i + 8);
        const rows = await Promise.allSettled(batch.map((pr) => githubFetch<GitHubReview[]>(authToken, `/repos/${repoOwner}/${repoInner}/pulls/${pr.number}/reviews?per_page=100`)));
        rows.forEach((x) => {
          if (x.status === "fulfilled") x.value.forEach((it) => it.body?.trim() && reviewBodies.push(it.body.trim()));
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
      const allPulls = await fetchAllPages<GitHubPull>(authToken, (page) => `/repos/${repoOwner}/${repoInner}/pulls?state=all&per_page=100&page=${page}&sort=created&direction=desc`);

      const meta: Record<number, PullMeta> = {};
      for (let i = 0; i < allPulls.length; i += 8) {
        const batch = allPulls.slice(i, i + 8);
        const rows = await Promise.allSettled(
          batch.map(async (pr) => {
            const reviews = await githubFetch<GitHubReview[]>(authToken, `/repos/${repoOwner}/${repoInner}/pulls/${pr.number}/reviews?per_page=100`);
            const mergedBy = pr.merged_at ? await fetchMergedBy(authToken, repoOwner, repoInner, pr.number) : null;
            return { reviews, mergedBy };
          })
        );
        rows.forEach((row, idx) => {
          const pr = batch[idx];
          const reviews = row.status === "fulfilled" ? row.value.reviews : [];
          const mergedBy = row.status === "fulfilled" ? row.value.mergedBy : null;
          const effective = reviews.filter(isEffectiveReview);
          meta[pr.number] = {
            day: parseDay(pr),
            reviews,
            reviewers: [...new Set(effective.map((r) => r.user?.login).filter(Boolean) as string[])],
            reviewed: effective.length > 0,
            latestReviewedAt: latestReviewAt(reviews),
            mergedBy,
          };
        });
      }

      setCurrentUser(user);
      setPulls(allPulls);
      setMetaByPr(meta);
      const firstPending = allPulls.find((pr) => pr.state === "open" && !meta[pr.number]?.reviewed);
      setSelectedPrNumber(firstPending ? firstPending.number : allPulls[0]?.number ?? null);
      loadHistoricalTemplates(authToken, repoOwner, repoInner, allPulls).catch((e: unknown) => setHistoryError(e instanceof Error ? e.message : "历史批注加载失败"));
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
    if (!selectedLearner && learnerStats.rows.length > 0) setSelectedLearner(learnerStats.rows[0].github);
  }, [learnerStats.rows, selectedLearner]);

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
      fetchAllPages<GitHubCommit>(token, (page) => `/repos/${owner}/${repoName}/pulls/${selectedItem.pr.number}/commits?per_page=100&page=${page}`),
      fetchAllPages<GitHubPullFile>(token, (page) => `/repos/${owner}/${repoName}/pulls/${selectedItem.pr.number}/files?per_page=100&page=${page}`),
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
    setSelectedLearner(null);
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
        body: JSON.stringify({ event: action, body: draftComment.trim() || "老师已完成本次批改。" }),
      });
      setDraftComment("");
      await loadDashboard(token, repo);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "提交批注失败";
      setError(message.includes("422") ? "提交失败：该 PR 可能已被其他老师刚处理，请刷新后重试。" : message);
    } finally {
      setSubmitting(false);
    }
  }

  const canReviewCurrent = selectedItem ? !selectedItem.pr.merged_at : false;
  const effectiveReviews = selectedItem ? selectedItem.meta.reviews.filter(isEffectiveReview).sort((a, b) => new Date(b.submitted_at || "").getTime() - new Date(a.submitted_at || "").getTime()) : [];

  return (
    <div className="min-h-screen px-4 py-6 text-[var(--text-strong)] sm:px-6 lg:px-10">
      <div className="mx-auto max-w-7xl space-y-5">
        <header className="rounded-3xl border border-[var(--line)] bg-[var(--card)]/95 p-5 shadow-[0_20px_60px_-35px_rgba(15,23,32,0.45)]">
          <div className="grid gap-4 md:grid-cols-[1.4fr_1fr]">
            <div>
              <p className="inline-flex rounded-full border border-amber-300 bg-amber-100 px-3 py-1 text-xs font-bold text-amber-900">Teacher Collaboration Console</p>
              <h1 className="mt-2 text-3xl font-bold">WWW6.5 共学批改平台</h1>
              <p className="mt-2 text-sm text-[var(--text-soft)]">已按场景划分：上半区是助教批改协作，下半区是学员打卡统计。</p>
            </div>
            <div className="rounded-2xl border border-[var(--line)] bg-white/80 p-4">
              <input value={repo} onChange={(e) => setRepo(e.target.value)} className="w-full rounded-xl border border-[var(--line)] bg-white px-3 py-2 text-sm" placeholder="owner/repo" />
              <p className="mt-2 text-sm">状态：{currentUser ? `已连接 @${currentUser.login}` : "未登录"}</p>
              <input value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} type="password" className="mt-2 w-full rounded-xl border border-[var(--line)] bg-white px-3 py-2 text-sm" placeholder="粘贴 ghp_ 开头的 classic token" />
              <div className="mt-2 flex gap-2">
                <button onClick={handleLogin} disabled={loading} className="flex-1 rounded-xl bg-[var(--bg-ink)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">{loading ? "同步中..." : "登录并同步"}</button>
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

        <section className="rounded-3xl border border-[var(--line)] bg-[var(--card)]/95 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xl font-bold">1、助教批改区域</h2>
            <p className="text-xs text-[var(--text-soft)]">协作规则：只要有批改记录，就不在待批改中出现。</p>
          </div>
          <div className="grid gap-4 xl:grid-cols-[1.1fr_1.7fr]">
            <div className="space-y-3">
              <div className="rounded-2xl border border-[var(--line)] bg-white/85 p-3">
                <h3 className="text-sm font-bold">待批改 PR（无人批注）</h3>
                <div className="mt-2 max-h-40 space-y-1 overflow-auto text-xs">
                  {teacherStats.pendingQueue.map((item) => (
                    <button key={item.pr.number} onClick={() => setSelectedPrNumber(item.pr.number)} className="block w-full rounded-md border border-[var(--line)] px-2 py-1 text-left hover:bg-amber-50">
                      #{item.pr.number} @{item.pr.user.login} · {item.meta.day ? `Day${item.meta.day}` : "未识别Day"}
                    </button>
                  ))}
                  {teacherStats.pendingQueue.length === 0 ? <p className="text-[var(--text-soft)]">暂无待批改。</p> : null}
                </div>
              </div>

              <div className="rounded-2xl border border-[var(--line)] bg-white/85 p-3">
                <h3 className="text-sm font-bold">我已批改未合并通过</h3>
                <div className="mt-2 max-h-40 space-y-1 overflow-auto text-xs">
                  {teacherStats.myReviewedUnmerged.map(({ item, at }) => (
                    <button key={item.pr.number} onClick={() => setSelectedPrNumber(item.pr.number)} className="block w-full rounded-md border border-[var(--line)] px-2 py-1 text-left hover:bg-amber-50">
                      #{item.pr.number} @{item.pr.user.login} · 批改于 {formatDate(at)}
                    </button>
                  ))}
                  {teacherStats.myReviewedUnmerged.length === 0 ? <p className="text-[var(--text-soft)]">暂无记录。</p> : null}
                </div>
              </div>

              <div className="rounded-2xl border border-[var(--line)] bg-white/85 p-3">
                <h3 className="text-sm font-bold">我已批改已合并通过</h3>
                <div className="mt-2 max-h-40 space-y-1 overflow-auto text-xs">
                  {teacherStats.myReviewedMerged.map(({ item, at }) => (
                    <button key={item.pr.number} onClick={() => setSelectedPrNumber(item.pr.number)} className="block w-full rounded-md border border-[var(--line)] px-2 py-1 text-left hover:bg-amber-50">
                      #{item.pr.number} @{item.pr.user.login} · 合并于 {formatDate(at)}
                    </button>
                  ))}
                  {teacherStats.myReviewedMerged.length === 0 ? <p className="text-[var(--text-soft)]">暂无记录。</p> : null}
                </div>
              </div>

              <div className="rounded-2xl border border-[var(--line)] bg-white/85 p-3">
                <h3 className="text-sm font-bold">协作工作量统计</h3>
                <p className="mt-1 text-xs">待批改 PR：<b>{teacherStats.pendingQueue.length}</b></p>
                <p className="text-xs">已批改 PR：<b>{teacherStats.reviewedCount}</b></p>
                <p className="text-xs">已合并 PR：<b>{teacherStats.mergedCount}</b></p>
                <div className="mt-2 max-h-24 space-y-1 overflow-auto text-xs">
                  {teacherStats.teacherRows.map((row) => (
                    <p key={row.login} className="rounded-md bg-[var(--bg-paper)]/80 px-2 py-1">@{row.login}：{row.count} 次批改</p>
                  ))}
                  {teacherStats.teacherRows.length === 0 ? <p className="text-[var(--text-soft)]">暂无批改记录。</p> : null}
                </div>
              </div>

              <div className="rounded-2xl border border-[var(--line)] bg-white/85 p-3">
                <h3 className="text-sm font-bold">已有产出的助教列表（贡献情况）</h3>
                <p className="mt-1 text-xs text-[var(--text-soft)]">按总批改次数排序，帮助快速了解各位助教的贡献分布。</p>
                <div className="mt-2 max-h-56 space-y-1 overflow-auto text-xs">
                  {teacherStats.contributionRows.map((row) => (
                    <div key={row.login} className="rounded-md border border-[var(--line)] bg-[var(--bg-paper)]/65 px-2 py-1">
                      <p className="font-semibold">@{row.login}</p>
                      <p className="text-[11px] text-[var(--text-soft)]">总产出 {row.total} 次（批改 {row.reviewTotal} + 合并 {row.mergeTotal}）· 覆盖 PR {row.coveredPrs} 个 · 已合并跟进 {row.mergedFollowUps} 个</p>
                      <p className="text-[11px] text-[var(--text-soft)]">批改动作：通过 {row.approve} · 请求修改 {row.requestChanges} · 仅评论 {row.comment}</p>
                    </div>
                  ))}
                  {teacherStats.contributionRows.length === 0 ? <p className="text-[var(--text-soft)]">暂无助教批改产出。</p> : null}
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <div className="rounded-2xl border border-[var(--line)] bg-white/85 p-3">
                <h3 className="text-sm font-bold">PR 详情与批改</h3>
                {!selectedItem ? (
                  <p className="mt-2 text-xs text-[var(--text-soft)]">请选择左侧任意 PR。</p>
                ) : (
                  <>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      <b>#{selectedItem.pr.number} @{selectedItem.pr.user.login}</b>
                      {selectedItem.meta.reviewed ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-800">已批改</span> : null}
                      {selectedItem.pr.merged_at ? <span className="rounded-full bg-blue-100 px-2 py-0.5 text-blue-800">已合并</span> : null}
                    </div>
                    <p className="mt-1 text-xs text-[var(--text-soft)]">创建 {formatDate(selectedItem.pr.created_at)} · {selectedItem.meta.day ? `Day${selectedItem.meta.day}` : "未识别Day"}</p>
                    <a className="text-xs text-sky-700 underline" href={selectedItem.pr.html_url} target="_blank" rel="noreferrer">{selectedItem.pr.html_url}</a>

                    <div className="mt-3 rounded-xl border border-[var(--line)] p-2">
                      <p className="text-xs font-semibold">已有批注记录</p>
                      <div className="mt-1 max-h-28 space-y-1 overflow-auto text-xs">
                        {effectiveReviews.map((review) => (
                          <div key={review.id} className="rounded-md bg-[var(--bg-paper)]/70 px-2 py-1">
                            <p>@{review.user?.login ?? "unknown"} · {review.state} · {formatDate(review.submitted_at)}</p>
                            {review.body ? <p className="mt-0.5 whitespace-pre-wrap text-[11px]">{review.body}</p> : null}
                          </div>
                        ))}
                        {effectiveReviews.length === 0 ? <p className="text-[var(--text-soft)]">暂无批注。</p> : null}
                      </div>
                    </div>

                    <div className="mt-3 rounded-xl border border-[var(--line)] p-2">
                      <p className="text-xs font-semibold">Commit 列表（{prCommits.length}）</p>
                      {prDetailLoading ? <p className="mt-1 text-xs text-[var(--text-soft)]">正在加载...</p> : null}
                      {prDetailError ? <p className="mt-1 text-xs text-rose-700">{prDetailError}</p> : null}
                      <div className="mt-1 max-h-28 space-y-1 overflow-auto text-xs">
                        {prCommits.map((commit) => (
                          <div key={commit.sha} className="rounded-md border border-[var(--line)] px-2 py-1">
                            <a href={commit.html_url} target="_blank" rel="noreferrer" className="font-semibold text-sky-700 underline">{commit.sha.slice(0, 7)}</a> · {commit.commit.message.split("\n")[0]}
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="mt-3 rounded-xl border border-[var(--line)] p-2">
                      <p className="text-xs font-semibold">代码改动（{prFiles.length} 文件）</p>
                      <div className="mt-1 max-h-64 space-y-2 overflow-auto text-xs">
                        {prFiles.map((file) => {
                          const readablePreview = toReadableCodePreview(file.patch);
                          return (
                            <div key={file.filename} className="rounded-md border border-[var(--line)] px-2 py-1">
                              <div className="flex items-start justify-between gap-2">
                                <a href={file.blob_url} target="_blank" rel="noreferrer" className="font-semibold text-sky-700 underline">{file.filename}</a>
                                <button
                                  type="button"
                                  onClick={() => copyText(readablePreview, file.filename)}
                                  disabled={!readablePreview}
                                  className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  {copiedFile === file.filename ? "已复制" : "复制代码"}
                                </button>
                              </div>
                              <p className="text-[11px] text-[var(--text-soft)]">{file.status} · +{file.additions} / -{file.deletions}</p>
                              {readablePreview ? (
                                <pre className="mt-1 overflow-x-auto rounded bg-[#101b24] p-2 text-[10px] text-slate-100"><code>{readablePreview}</code></pre>
                              ) : (
                                <p className="text-[11px] text-[var(--text-soft)]">原文件过大或为空，无法正常在此展示，请点击链接查看详情确认。</p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {canReviewCurrent ? (
                      <div className="mt-3 rounded-xl border border-[var(--line)] p-2">
                        <p className="text-xs font-semibold">快捷批注</p>
                        <div className="mt-2 grid gap-2 md:grid-cols-3">
                          <label className="rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-xs">绿色：好评<select defaultValue="" className="mt-1 w-full rounded border border-emerald-300 bg-white p-1" onChange={(e) => { appendTemplateToComment(e.target.value); e.target.value = ""; }}><option value="">请选择</option>{praiseTemplates.map((x) => <option key={x} value={x}>{x}</option>)}</select></label>
                          <label className="rounded-lg border border-rose-200 bg-rose-50 p-2 text-xs">红色：错误<select defaultValue="" className="mt-1 w-full rounded border border-rose-300 bg-white p-1" onChange={(e) => { appendTemplateToComment(e.target.value); e.target.value = ""; }}><option value="">请选择</option>{errorTemplates.map((x) => <option key={x} value={x}>{x}</option>)}</select></label>
                          <label className="rounded-lg border border-sky-200 bg-sky-50 p-2 text-xs">蓝色：建议<select defaultValue="" className="mt-1 w-full rounded border border-sky-300 bg-white p-1" onChange={(e) => { appendTemplateToComment(e.target.value); e.target.value = ""; }}><option value="">请选择</option>{suggestionTemplates.map((x) => <option key={x} value={x}>{x}</option>)}</select></label>
                          <label className="rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs md:col-span-3">历史批注参考（去重，不分类）
                            <div className="mt-1 flex items-center gap-2">
                              <select defaultValue="" className="w-full rounded border border-slate-300 bg-white p-1" onChange={(e) => { appendTemplateToComment(e.target.value); e.target.value = ""; }}>
                                <option value="">请选择历史批注</option>
                                {historyTemplates.map((x) => <option key={x} value={x}>{x}</option>)}
                              </select>
                              <button type="button" onClick={() => { if (!token || !owner || !repoName) return; loadHistoricalTemplates(token, owner, repoName, pulls).catch((e: unknown) => setHistoryError(e instanceof Error ? e.message : "刷新历史批注失败")); }} className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold">{historyLoading ? "加载中" : "刷新"}</button>
                            </div>
                            {historyError ? <p className="mt-1 text-[11px] text-rose-700">{historyError}</p> : null}
                          </label>
                        </div>
                        <textarea value={draftComment} onChange={(e) => setDraftComment(e.target.value)} className="mt-2 h-24 w-full rounded-xl border border-[var(--line)] bg-white p-2 text-sm" placeholder="输入批注" />
                        <p className="mt-2 text-[11px] text-[var(--text-soft)]">鼠标悬停按钮可查看操作区别说明，帮助不熟悉 GitHub 的助教快速理解。</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <button
                            onClick={() => submitReview("APPROVE")}
                            disabled={submitting}
                            title={reviewActionTips.APPROVE}
                            aria-label={reviewActionTips.APPROVE}
                            className="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
                          >
                            批注并通过
                          </button>
                          <button
                            onClick={() => submitReview("REQUEST_CHANGES")}
                            disabled={submitting}
                            title={reviewActionTips.REQUEST_CHANGES}
                            aria-label={reviewActionTips.REQUEST_CHANGES}
                            className="rounded-lg bg-orange-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
                          >
                            请求修改
                          </button>
                          <button
                            onClick={() => submitReview("COMMENT")}
                            disabled={submitting}
                            title={reviewActionTips.COMMENT}
                            aria-label={reviewActionTips.COMMENT}
                            className="rounded-lg bg-sky-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-60"
                          >
                            仅评论
                          </button>
                        </div>
                      </div>
                    ) : (
                      <p className="mt-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">该 PR 已合并，按规则仅查看详情，不支持继续操作。</p>
                    )}
                  </>
                )}
              </div>

              <div className="rounded-2xl border border-[var(--line)] bg-white/85 p-3">
                <h3 className="text-sm font-bold">历史总 PR 列表（提交时间倒序）</h3>
                <div className="mt-2 max-h-56 space-y-1 overflow-auto text-xs">
                  {teacherStats.historyList.map((item) => (
                    <button key={item.pr.number} onClick={() => setSelectedPrNumber(item.pr.number)} className="block w-full rounded-md border border-[var(--line)] px-2 py-1 text-left hover:bg-amber-50">
                      <div className="flex items-center justify-between gap-2">
                        <span>#{item.pr.number} @{item.pr.user.login}</span>
                        <div className="flex items-center gap-1">
                          {item.meta.reviewed ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-800">已批改</span> : null}
                          {item.pr.merged_at ? <span className="rounded-full bg-blue-100 px-2 py-0.5 text-blue-800">已合并</span> : null}
                        </div>
                      </div>
                      <p className="text-[11px] text-[var(--text-soft)]">提交 {formatDate(item.pr.created_at)}</p>
                      {item.meta.reviewed ? <p className="text-[11px] text-[var(--text-soft)]">批改老师：{item.meta.reviewers.map((x) => `@${x}`).join(", ")} · {formatDate(item.meta.latestReviewedAt)}</p> : null}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-3xl border border-[var(--line)] bg-[var(--card)]/95 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-xl font-bold">2、学员打卡统计区域</h2>
            <p className="text-xs text-[var(--text-soft)]">按学员聚合：看打卡、周通过率、30天闯关结果。</p>
          </div>
          <div className="grid gap-4 xl:grid-cols-[1fr_1.8fr]">
            <div className="space-y-3">
              <div className="rounded-2xl border border-[var(--line)] bg-white/85 p-3">
                <h3 className="text-sm font-bold">已参与提交的学员列表</h3>
                <div className="mt-2 max-h-[420px] space-y-1 overflow-auto text-xs">
                  {learnerStats.rows.map((row) => (
                    <button key={row.github} onClick={() => setSelectedLearner(row.github)} className={`block w-full rounded-md border px-2 py-1 text-left ${selectedLearner === row.github ? "border-amber-400 bg-amber-50" : "border-[var(--line)] hover:bg-amber-50"}`}>
                      @{row.github} · 闯关到 Day{row.challengeDay}
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-2xl border border-[var(--line)] bg-white/85 p-3">
                <h3 className="text-sm font-bold">学员打卡统计面板</h3>
                <p className="mt-1 text-xs">历史总 PR：<b>{learnerStats.totalPrs}</b></p>
                <p className="text-xs">启动挑战学员：<b>{learnerStats.starters}</b></p>
                <p className="text-xs">30天最终闯关成功：<b>{learnerStats.passers.length}</b>（{learnerStats.finalPassRate}%）</p>
                <p className="text-xs">未识别 Day 的 PR：<b>{learnerStats.unresolvedDayPRs}</b></p>
                <div className="mt-2 space-y-1 text-xs">
                  {learnerStats.weekly.map((w) => (
                    <div key={w.week} className="rounded-md bg-[var(--bg-paper)]/80 px-2 py-1">第{w.week}周 Day{w.start}-{w.end} 通过率：{w.passCount}/{learnerStats.rows.length || 1}（{w.rate}%）</div>
                  ))}
                </div>
                <div className="mt-3">
                  <p className="text-xs font-semibold">Day1-Day30 日统计（分母=已提交过至少1个PR的学员）</p>
                  <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-6">
                    {learnerStats.daily.map((d) => (
                      <div key={d.day} className="rounded-md border border-[var(--line)] bg-white px-1.5 py-1 text-center">
                        <p className="text-[11px] font-semibold">Day{d.day}</p>
                        <p className="text-[11px] text-[var(--text-soft)]">{d.successCount}/{learnerStats.starters}</p>
                        <p className="text-[11px] text-emerald-700">{d.rate}%</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <div className="rounded-2xl border border-[var(--line)] bg-white/85 p-3">
                <h3 className="text-sm font-bold">学员详情</h3>
                {!selectedLearnerRow ? (
                  <p className="mt-2 text-xs text-[var(--text-soft)]">请先选择左侧学员。</p>
                ) : (
                  <>
                    <p className="mt-1 text-sm font-semibold">@{selectedLearnerRow.github}</p>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3 text-xs">
                      <p className="rounded-md bg-[var(--bg-paper)]/80 px-2 py-1">提交 PR 次数：<b>{selectedLearnerRow.submissionCount}</b></p>
                      <p className="rounded-md bg-[var(--bg-paper)]/80 px-2 py-1">已批改：<b>{selectedLearnerRow.reviewedCount}</b></p>
                      <p className="rounded-md bg-[var(--bg-paper)]/80 px-2 py-1">未批改：<b>{selectedLearnerRow.unreviewedCount}</b></p>
                      <p className="rounded-md bg-[var(--bg-paper)]/80 px-2 py-1">已合并：<b>{selectedLearnerRow.mergedCount}</b></p>
                      <p className="rounded-md bg-[var(--bg-paper)]/80 px-2 py-1">准时/逾期/缺交：<b>{selectedLearnerRow.onTime}/{selectedLearnerRow.late}/{selectedLearnerRow.missing}</b></p>
                      <p className="rounded-md bg-[var(--bg-paper)]/80 px-2 py-1">闯关到：<b>Day{selectedLearnerRow.challengeDay}</b>{selectedLearnerRow.finalPass ? "（30天完成）" : ""}</p>
                    </div>
                  </>
                )}
              </div>

              <div className="rounded-2xl border border-[var(--line)] bg-white/85 p-3">
                <h3 className="text-sm font-bold">该学员 PR 提交列表（含状态标签）</h3>
                <div className="mt-2 max-h-[380px] space-y-1 overflow-auto text-xs">
                  {(selectedLearnerRow?.pulls ?? []).map(({ pr, meta }) => {
                    const dayStatus = meta.day ? (new Date(pr.created_at).getTime() <= getWeekDeadline(meta.day).getTime() ? "准时" : "逾期") : "未识别Day";
                    return (
                      <button key={pr.number} onClick={() => setSelectedPrNumber(pr.number)} className="block w-full rounded-md border border-[var(--line)] px-2 py-1 text-left hover:bg-amber-50">
                        <div className="flex items-center justify-between gap-2">
                          <span>#{pr.number} · {meta.day ? `Day${meta.day}` : "Day?"}</span>
                          <div className="flex items-center gap-1">
                            {meta.reviewed ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-800">已批改</span> : <span className="rounded-full bg-orange-100 px-2 py-0.5 text-orange-800">待批改</span>}
                            {pr.merged_at ? <span className="rounded-full bg-blue-100 px-2 py-0.5 text-blue-800">已合并</span> : null}
                            <span className={`rounded-full px-2 py-0.5 ${dayStatus === "准时" ? "bg-lime-100 text-lime-800" : dayStatus === "逾期" ? "bg-rose-100 text-rose-800" : "bg-slate-100 text-slate-700"}`}>{dayStatus}</span>
                          </div>
                        </div>
                        <p className="text-[11px] text-[var(--text-soft)]">提交 {formatDate(pr.created_at)}</p>
                      </button>
                    );
                  })}
                  {!selectedLearnerRow || selectedLearnerRow.pulls.length === 0 ? <p className="text-[var(--text-soft)]">暂无提交记录。</p> : null}
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}