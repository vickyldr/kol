# 部署到 Railway，自己用（一次拖一堆文件核对）

只要 3 样东西就能跑起来，全是你能搞定的：
1. 这个代码（已配好 Railway 部署文件）；
2. 一个 Railway 账号（你有）；
3. **一个读 PDF 的 AI API key**（唯一要你准备的，见下）。

---

## 第 1 步：准备 AI API key（唯一前置）

网页读 PDF 那步需要一个 AI 接口。**用你自己的个人 key 即可**（不是公司的），很便宜，
一份文件大概几分钱。默认用 Anthropic Claude：

1. 去 https://console.anthropic.com → 注册 → 充值（充 5 美元够用很久）；
2. 建一个 API Key，复制好（`sk-ant-...`）。

> 不想用 Anthropic 也行（Google Gemini 有免费额度、OpenAI 也可），告诉我，我改一下识别那段代码。

## 第 2 步：部署到 Railway

1. 把这份代码推到你自己的 GitHub 仓库；
2. Railway → New Project → Deploy from GitHub repo → 选这个仓库；
3. Railway 会自动认出是 Python 项目并构建（已带 `Procfile` / `railway.json`）。

## 第 3 步：设环境变量（Railway → Variables）

| 变量名 | 值 | 作用 |
|---|---|---|
| `ANTHROPIC_API_KEY` | 你的 `sk-ant-...` | 读 PDF 的 AI |
| `ACCESS_USER` | 自己起个用户名 | 登录用户名 |
| `ACCESS_PASSWORD` | 自己起个密码 | **登录密码（财务数据，必设！）** |

> 设了 `ACCESS_PASSWORD`，网页就需要账号密码才能进，不会被别人乱用。
> 不设密码也能跑，但**公网千万别不设密码**。

## 第 4 步：用

1. Railway 部署完会给你一个网址（`xxx.up.railway.app`）；
2. 打开 → 输你设的账号密码 → 把当天所有 PDF 一次拖进去 → 点核对 → 出总表。

---

## 关于数据

- 文件里的内容（含银行账号等）会发到你设的那个 AI 接口（Anthropic）去识别——
  这跟你现在把文件发给我核对是一回事，是**你个人在用**。
- 比对算账全在你自己的 Railway 服务器上，不外发。
- 如果将来要给**公司**用、财务要求"数据不出内网"，那就把识别后端换成公司内部 OCR/
  私有模型（见《数据安全与财务敏感性评估.md》）——那是公司版的事，你自己用不用管。

## 跑不起来时

- 构建失败：确认 `requirements.txt` 在仓库根目录；
- 打开网页 500：多半是 `ANTHROPIC_API_KEY` 没设或余额为 0；
- 进不去要密码：那是正常的，输你设的 `ACCESS_USER` / `ACCESS_PASSWORD`。
