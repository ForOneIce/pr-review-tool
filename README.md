# WWW6.5 助教批改与学员打卡统计看板

一个基于 **React + Vite + Tailwind CSS** 的前端工具，用于共学活动中：

- 助教协作批改 PR
- 学员打卡进度统计（Day1~Day30）
- 周截止规则下的闯关通过率统计

当前版本为**纯前端部署**（可部署到 GitHub Pages / Vercel），通过 GitHub API 实时读取与提交数据。

---

## 1. 功能概览

### 助教批改区域

- 待批改 PR（无人批注）
- 我已批改未合并 PR（按批改时间倒序）
- 我已批改已合并 PR（按合并时间倒序）
- 历史总 PR 列表（按提交时间倒序，带批改/合并标签）
- 协作工作量统计
  - 待批改数、已批改数、已合并数
  - 各助教批改次数
  - 已有产出的助教列表（总产出=批改+合并）
- PR 详情支持查看：
  - Commit 列表
  - 文件改动与 patch（过大/为空文件会提示跳转 GitHub 查看）
  - 已有批注记录
- 快捷批注模板：
  - 绿色（好评）/ 红色（错误）/ 蓝色（建议）
  - 历史批注去重下拉（不分类）
  - 选择模板后自动追加到批注文本框
- 支持 3 种 Review 操作：
  - 批注并通过（Approve）
  - 请求修改（Request changes）
  - 仅评论（Comment）
  - 按钮 hover 显示差异说明，方便 GitHub 新手助教

### 学员打卡统计区域

- 已参与提交学员列表（点击查看个人详情）
- 学员详情：
  - 提交 PR 次数
  - 已批改/未批改/已合并次数
  - 准时/逾期/缺交
  - 闯关到 DayN
- 学员 PR 列表（带状态标签）
- 学员打卡统计面板：
  - 启动挑战学员数（历史提交过至少 1 个 PR）
  - 每周通过率
  - 30 天最终闯关通过率
  - Day1~Day30 日统计方格（分母=已参与学员）

---

## 2. 统计规则（当前实现）

- Day 识别：从 PR 标题 / 分支名 / 描述中匹配 `dayN`
- 周截止：按 3 月起始，第 7/14/21/28/30 天为各周截止，截止到当日 23:59:59
- 准时提交：对应 Day 的 PR 创建时间 <= 该周截止时间
- 学员挑战通过：Day1~Day30 全部准时提交
- 待批改 PR：`open` 且暂无有效 review 记录

> 说明：如果学员 PR 命名不规范（例如无法识别 day），会被计入“未识别 Day 的 PR”。

---

## 3. 新手登录指南（推荐）

本项目使用 GitHub Token 直接访问 API（纯前端，无后端 OAuth 中转）。

### 推荐使用 Classic Token

1. 打开：`https://github.com/settings/tokens`
2. 进入 **Tokens (classic)**
3. 点击 **Generate new token (classic)**
4. Note 自定义（如 `WWW6.5-review`）
5. Expiration 选择 30 天或 90 天
6. 勾选权限：`repo`（关键）
7. 生成后复制 token（只显示一次）
8. 回到页面粘贴 token，输入仓库 `owner/repo`（示例：`0xherstory/WWW6.5`）登录

> 协作者场景下，Classic Token 一般比 Fine-grained Token 更稳定。

---

## 4. 本地开发

```bash
npm install
npm run dev
```

构建：

```bash
npm run build
```

---

## 5. 部署说明（无后端）

### Vercel

- 导入仓库
- Framework 选择 Vite（通常自动识别）
- Build Command: `npm run build`
- Output Directory: `dist`

### GitHub Pages

- 可使用任意 Pages 发布方案（例如 Action 构建后发布 `dist`）
- 确保前端可访问 `https://api.github.com`

---

## 6. 运维与安全注意事项

- Token 仅保存在当前浏览器 `localStorage`
- 建议使用短有效期 token，并定期轮换
- 不要在公开场合共享 token
- 若老师离开项目，请立即在 GitHub 撤销其 token

---

## 7. 已知限制

- 纯前端方案无法做到企业级 token 安全托管
- GitHub API 有速率限制；仓库 PR 特别多时首次加载会较慢
- 同一 PR 多助教并发批改时，允许多条 review 共存；极端情况下会收到“已被处理”提示，刷新即可
