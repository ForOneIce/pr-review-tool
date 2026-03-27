# PR 自动化脚本说明

## 前置条件

- 已安装并登录 `gh`（GitHub CLI）
- Token 至少具备 `repo` 权限

## `pr-precheck.mjs`（PR 审核与执行）

### 用途

- 审核 open PR（规则 0~4）
- 输出检查报告
- 在执行模式下自动评论 / 关闭 / 合并
- 合并成功后按规则补打 `weekN-late` 标签（N 由 `--week-config` 决定，如 `week1..week5`）

### 常用命令

仅预检查：

```bash
node prautocheck/pr-precheck.mjs --repo "0xherstory/WWW6.5" --apply
```

执行模式（自动执行动作）：

```bash
node prautocheck/pr-precheck.mjs --repo "0xherstory/WWW6.5" --apply --yes
```

### 关键规则说明

- `open PR = 0` 时直接结束，不输出报告
- 第 `4-0` 步会拦截空白改动（`Whitespace-only changes.`）
- 第 1 步仅校验“是否可识别 dayN”，不再限制 day 重复与严格命名格式
- 超时判定时间使用 `PR.created_at`（北京时间）
- 对“补交历史周”的判定采用单 PR 局部逻辑：只有“完全新增且属于超时周”的 day 才打 `weekN-late`

### 主要参数

- `--repo owner/repo`
- `--pr 101,102,103`
- `--output prautocheck/reports/custom.xlsx`
- `--apply`
- `--yes`
- `--merge-method merge|squash|rebase`
- `--week-config prautocheck/week-config.example.json`（优先）
- `--week1-deadline 2026-03-09T00:00:00+08:00`（未传 week-config 时推导后续周）

## `pr-batch-action.mjs`（批量动作）

### 用途

- 对指定 PR 批量执行：评论 / 关闭 / 合并 / 改标题

### 常用命令

仅评论：

```bash
npm run pr:batch -- --repo 0xherstory/WWW6.5 --pr 101,102,103 --mode comment --comment "请补充命名格式"
```

批量关闭并评论：

```bash
npm run pr:batch -- --repo "0xherstory/WWW6.5" --pr "20,124,137,138,141" --mode "close" --comment "[脚本处理] 示例评论"
```

批量合并：

```bash
npm run pr:batch -- --repo 0xherstory/WWW6.5 --pr 120,121 --mode merge --merge-method squash
```

按规则批量改标题：

```bash
npm run pr:batch -- --repo "0xherstory/WWW6.5" --pr "20,124,137,138,141" --mode retitle
```

### 参数

- `--mode close|merge|comment|retitle`
- `--repo owner/repo`
- `--pr 1,2,3`
- `--comment "..."`（close/comment 必填）
- `--merge-method merge|squash|rebase`
- `--yes`

## `pr-stats.mjs`（项目方统计）

### 用途

- 输出周成功名单、最终闯关名单、超时标签名单
- 支持 API 模式与 filesystem 模式

### 常用命令

API 模式（默认）：

```bash
npm run pr:stats -- --repo 0xherstory/WWW6.5 --week-config prautocheck/week-config.example.json
```

filesystem 模式（历史量大更稳定）：

```bash
npm run pr:stats -- --mode filesystem --repo 0xherstory/WWW6.5 --repo-root . --week-config prautocheck/week-config.example.json --folder-map prautocheck/folder-map.example.json
```

静默输出（仅打印结果文件路径）：

```bash
npm run --silent pr:stats -- --mode filesystem --repo 0xherstory/WWW6.5 --repo-root . --week-config prautocheck/week-config.example.json --folder-map prautocheck/folder-map.example.json --output prautocheck/reports/current-roster.xlsx --quiet
```

如果 npm 参数被剥离，直接运行 node：

```bash
node prautocheck/pr-stats.mjs --mode filesystem --repo "0xherstory/WWW6.5" --repo-root "." --week-config "prautocheck/week-config.example.json" --folder-map "prautocheck/folder-map.example.json" --output "prautocheck/reports/current-roster.xlsx" --quiet
```

### 参数

- `--mode api|filesystem`
- `--repo owner/repo`
- `--repo-root .`（filesystem）
- `--folder-map prautocheck/folder-map.example.json`（filesystem 推荐）
- `--week-config prautocheck/week-config.example.json`
- `--week1-deadline ...`（未传 week-config 时使用）
- `--output ...`（会自动追加时间戳后缀）
- `--quiet`

### 输出 sheet

- `week_success_summary`
- `week_success_roster`（含 `submitter` / `github_accounts` / `owner_folders` / `success_days_count`）
- `final_no_late_champions`
- `all_submitter_progress`
- `merged_day_records`
- `late_accounts_by_label`（含 `github_login` / `owner_folders` / `note`）：`owner_folders` 来自带超时标签的 PR 的提交内容（该 PR 中新增 `.sol` 的顶层目录）；拉取 PR 文件失败时重试 3 次，仍失败则 `note` 标记为「异常」

说明：

- filesystem 模式优先扫本地 `--repo-root`
- 本地未发现有效作业时，会自动回退远程主仓库树扫描

## 定时任务脚本（Windows）

### `setup-pr-precheck-15min.ps1`

- 创建或更新定时任务（默认每 15 分钟）
- 可用 `-IntervalMinutes` 调整周期
- 可用 `-WeekConfig` 指定周配置文件（默认 `prautocheck/week-config.example.json`）

创建并立即触发：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\prautocheck\setup-pr-precheck-15min.ps1" -Repo "0xherstory/WWW6.5" -TaskName "PRAutoCheck15Min" -RunNow
```

### `run-precheck-hourly.ps1`

- 定时任务实际执行脚本
- 负责调用 `pr-precheck --apply --yes`、重试与日志

日志规则：

- 日志目录：`prautocheck/reports/task-logs/`
- 最近摘要：`prautocheck/reports/task-logs/latest-run.log`
- `open PR = 0` 时不产生日志
- 网络抖动自动重试最多 3 次（每次 30 秒）
# PR 预检查脚本使用说明

## 1) 前置条件

- 已安装并登录 `gh`（GitHub CLI）
- Token 至少具备 `repo` 权限

## 2) 仅预检查（不执行评论/关闭/改标题）

```bash
npm run pr:precheck -- --repo 0xherstory/WWW6.5
```

执行后会输出 Excel 报告到 `prautocheck/reports/` 目录。

说明：

- 第 0 步之前新增了灾难性改动防护：若检测到删除了多个主目录第一层文件夹，将直接评论并关闭 PR
- 第 4 步已改为真实 `solc` 编译检测（语法级）
- 第 4-0 步新增空白改动拦截：若新增 `.sol` 全是 `Whitespace-only changes.`，将评论并关闭 PR
- 报告新增 `compile_error_reason` 列，记录每个 PR 的编译失败原因摘要
- 当筛选后的 open PR 数量为 `0` 时，脚本会直接结束，不输出报告文件
- 报告新增周次时效字段（基于 `PR.created_at` 判定是否超时）

## 3) 执行模式（完整自动化闭环）

```bash
npm run pr:precheck -- --repo 0xherstory/WWW6.5 --apply
```

执行模式会自动完成：

- 规则命中的评论会自动提交
- 不通过 PR 自动关闭
- 通过候选 PR 自动合并（默认 `squash`）
- 若出现执行异常，会记录失败 PR 并在批量结束后询问是否重试失败项

可选参数：

- `--yes`：跳过执行前确认与重试询问（全自动）
- `--merge-method merge|squash|rebase`：设置自动合并方式（默认 `squash`）
- `--week1-deadline 2026-03-09T00:00:00+08:00`：设置 week1 截止时间（week2/3/4 依次按 +7 天推导）
- `--week-config prautocheck/week-config.example.json`：统一周配置（优先级高于 `--week1-deadline`）

## 4) 常用参数

- `--repo owner/repo`：目标仓库
- `--pr 101,102,103`：只检查指定 PR 编号
- `--output prautocheck/reports/custom.xlsx`：指定报告路径
- `--yes`：执行模式下跳过确认/重试交互
- `--merge-method merge|squash|rebase`：执行模式自动合并方式（默认 `squash`）
- `--week1-deadline 2026-03-09T00:00:00+08:00`：week1 截止时间（默认值同左）
- `--week-config prautocheck/week-config.example.json`：自定义 week1~weekN 的 day 范围与截止时间

## 4.1) 周次超时与通过率统计说明

- 周次映射：优先读取 `--week-config`；未提供时按默认映射 `weekN = ceil(day/7)`（覆盖 `day1~day30`）
- 判定时间：使用 `PR.created_at`（不是 merge 时间）
- 超时规则：若该 PR 最大 `day` 对应周的截止时间已过，标记 `week_is_late=Y`
- 学员反馈：命中超时时自动评论，明确周次、提交时间、截止时间
- 标签策略：在 PR **合并成功后**打 `weekN-late`（`N` 由周配置动态决定）
- 组织者统计：Excel 新增 `week_stats` sheet，分母为“有提交的人（去重账号）”
- `week_stats` 关键列：
  - `submitter_count`
  - `pass_submitter_count`
  - `ontime_pass_submitter_count`
  - `late_pass_submitter_count`
  - `success_rate` / `ontime_success_rate` / `late_success_rate`
- `--week1-deadline 2026-03-09T00:00:00+08:00`：Week1 截止时间（基于 `PR.created_at` 判定超时，Week2+ 每周顺延 7 天）
- 周配置示例文件：`prautocheck/week-config.example.json`

## 5) 批量执行工具（关闭/合并/仅评论）

### 仅评论

```bash
npm run pr:batch -- --repo 0xherstory/WWW6.5 --pr 101,102,103 --mode comment --comment "请补充命名格式"
```

### 评论并关闭

```bash
npm run pr:batch -- --repo "0xherstory/WWW6.5" --pr "20,124,137,138,141" --mode "close" --comment "[脚本处理 0-1] 提交内容未识别到合约.sol文件,PR已关闭"


```

### 批量合并

```bash
npm run pr:batch -- --repo 0xherstory/WWW6.5 --pr 120,121 --mode merge --merge-method squash 
```


### 按规则批量改标题（自动取提交人账号 + 最大 DayN）

```bash
npm run pr:batch -- --repo "0xherstory/WWW6.5" --pr "20,124,137,138,141" --mode retitle

```

标题规则：

- `提交人{github账号名} 挑战尝试闯关到DayN`
- `N` = 该 PR 中 `status=added` 的 `.sol` 文件名里可提取的最大 `dayN`（1~30）

### 跳过交互确认

```bash
npm run pr:batch -- --repo 0xherstory/WWW6.5 --pr 120,121 --mode merge --yes
```

参数说明：

- `--mode close|merge|comment`：操作模式（必填）
- `--mode retitle`：按规则仅改标题
- `--comment`：评论内容（`close/comment` 模式必填）
- `--merge-method merge|squash|rebase`：仅 `merge` 模式有效，默认 `squash`
- `--yes`：跳过执行前确认

如果 npm 参数转发异常，也可以直接运行：

```bash
node prautocheck/pr-batch-action.mjs --repo "0xherstory/WWW6.5" --pr "20,124,137,138,141" --mode "close" --comment "[脚本处理 0-1] 提交内容未识别到合约.sol文件,PR已关闭"
```

## 6) 项目方统计（周成功名单 + 最终闯关名单）

用于项目组织者快速查看：
- 每周打卡成功学员清单（按周、按账号/文件夹）
- 最终完成 day1~day30 且全程未超时学员清单

API 模式（默认）：
```bash
npm run pr:stats -- --repo 0xherstory/WWW6.5 --week-config prautocheck/week-config.example.json
```

文件系统模式（更稳定，适合历史量大时）：

```bash
npm run pr:stats -- --mode filesystem --repo 0xherstory/WWW6.5 --repo-root . --week-config prautocheck/week-config.example.json --folder-map prautocheck/folder-map.example.json
```

说明：
- `filesystem` 模式会优先扫描 `--repo-root` 指向的本地仓库内容；
- 如果本地未扫描到有效 `.sol` 作业，会自动回退到远程主仓库树扫描，避免统计表为空。

如果 npm 出现参数剥离告警，建议直接运行 node：

```bash
node prautocheck/pr-stats.mjs --mode filesystem --repo "0xherstory/WWW6.5" --repo-root "." --week-config "prautocheck/week-config.example.json" --folder-map "prautocheck/folder-map.example.json" --output "prautocheck/reports/current-roster.xlsx" --quiet
```

静默输出（只打印结果文件路径）：

```bash
npm run --silent pr:stats -- --repo 0xherstory/WWW6.5 --week-config prautocheck/week-config.example.json --quiet
```

可选参数：
- `--output prautocheck/reports/pr-stats-custom.xlsx`：自定义输出文件（实际会自动追加时间戳后缀，避免覆盖冲突）
- `--mode api|filesystem`：统计模式（默认 `api`）
- `--week-config prautocheck/week-config.example.json`：统一周配置（推荐）
- `--week1-deadline 2026-03-09T00:00:00+08:00`：未传 `--week-config` 时，用于推导 week2+ 截止时间
- `--repo-root .`：filesystem 模式下主仓库根目录路径
- `--folder-map prautocheck/folder-map.example.json`：文件夹名到 GitHub 账号映射（filesystem 模式推荐）
- `--quiet`：命令行静默模式，仅输出生成的文件路径

输出 Excel 包含这些 sheet：
- `week_success_summary`：每周成功人数与按时占比
- `week_success_roster`：周打卡成功学员清单（含 `submitter` 与 `owner_folders`）
- `final_no_late_champions`：最终完成所有作业且全程未超时名单
- `all_submitter_progress`：所有提交学员的完成进度明细（含 `submitter` 与 `owner_folders`）
- `merged_day_records`：按合并 PR 拆分到 day 的原始记录
- `late_accounts_by_label`：按 `weekN-late` 标签汇总的超时账号列表；`owner_folders` 通过查询带该标签的 PR 并识别其提交内容中的昵称文件夹（顶层目录）得到；单次 PR 的 files 请求失败会重试 3 次，仍失败则 `note` 列为「异常」

## 7) Windows 定时自动执行（无交互）

说明：定时任务实际执行的是 `--apply --yes`，即每次都会自动执行评论/关闭/合并。

### 每 15 分钟执行一次（推荐）

在项目根目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\prautocheck\setup-pr-precheck-15min.ps1" -Repo "0xherstory/WWW6.5" -TaskName "PRAutoCheck15Min"
```

注册后立即触发一次：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\prautocheck\setup-pr-precheck-15min.ps1" -Repo "0xherstory/WWW6.5" -TaskName "PRAutoCheck15Min" -RunNow
```

### 查看/手动触发/删除任务

```powershell
Get-ScheduledTask -TaskName "PRAutoCheck15Min" | Get-ScheduledTaskInfo
Start-ScheduledTask -TaskName "PRAutoCheck15Min"
Unregister-ScheduledTask -TaskName "PRAutoCheck15Min" -Confirm:$false
```

### 日志与重试规则

- 日志目录：`prautocheck/reports/task-logs/`
- 最近一次摘要：`prautocheck/reports/task-logs/latest-run.log`
- 当 open PR 数量为 `0` 时，不产生任何日志文件（按需静默）
- 遇到网络抖动（如 `error connecting to api.github.com`）会自动重试最多 `3` 次，每次间隔 `30` 秒
- 合并失败/接口异常等错误会写入日志，便于追查

## 7) 周次超时与闯关统计

- 超时判定时间：`PR.created_at`（北京时间）
- 周次规则：`day1-7=week1`, `day8-14=week2`, `day15-21=week3`, `day22-28=week4`, `day29-30=week5`
- 若 PR 命中周次且超时，会自动追加超时评论（不影响其他规则动作）
- Excel 报告新增 `week_stats` sheet，用“有提交的人（去重账号）”作为通过率分母

