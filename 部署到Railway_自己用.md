# 部署到 Railway，自己用（用你的 Claude Code token，不额外花钱）

识别后端走**路 A**：复用你的 Claude Code 订阅 token，**不用开 Anthropic API key、不额外花钱**。

只要 3 步。

---

## 第 1 步：生成 Claude Code token

在你本地装了 Claude Code 的电脑上跑：

```bash
claude setup-token
```

会输出一个长 token（`sk-ant-oat...` 之类），复制好。这就是服务器上认证用的。

## 第 2 步：部署到 Railway

1. 把这份代码推到你自己的 GitHub 仓库；
2. Railway → New Project → Deploy from GitHub repo → 选这个仓库；
3. 构建用 `Dockerfile`（已带好，会自动装 **Python + Node + Claude Code CLI**），
   Railway 自动识别并构建，不用你管（首次构建几分钟）。

## 第 3 步：设环境变量（Railway → Variables）

| 变量名 | 值 | 作用 |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | 第 1 步生成的 token | 识别 PDF（用你的订阅）|
| `ACCESS_USER` | 自己起个用户名 | 登录用户名 |
| `ACCESS_PASSWORD` | 自己起个密码 | **登录密码（财务数据，必设！）** |

> 不用设 `ANTHROPIC_API_KEY`。代码会自动判断：有 `CLAUDE_CODE_OAUTH_TOKEN`、
> 没 API key → 自动走 Claude Code。
> （想强制指定也行：设 `KOL_BACKEND=claude_code`。）

## 用

1. Railway 部署完给你一个网址（`xxx.up.railway.app`）；
2. 打开 → 输你设的账号密码 → 把当天所有 PDF 一次拖进去 → 出总表。

---

## 路 B 备选（不想用 Claude Code token 时）

改用 Anthropic API key：设 `ANTHROPIC_API_KEY=sk-ant-...`（去 console.anthropic.com 开，
按量付费、月几美元）。代码自动切到 API 后端，最稳最快。两套后端随时用环境变量切。

## 跑不起来时

- 构建失败：确认 `Dockerfile`、`requirements.txt` 在仓库根目录；
- 打开网页 500 / 识别报错：多半是 `CLAUDE_CODE_OAUTH_TOKEN` 没设或过期，重新 `claude setup-token`；
- 识别慢：Claude Code 是跑一个 agent，比单次 API 略慢属正常；想更快可改走路 B（API）。
- 要密码：正常，输你设的 `ACCESS_USER` / `ACCESS_PASSWORD`。
