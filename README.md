# 信用卡管家（mycards）

个人使用的信用卡管理小工具，部署在 Cloudflare Workers（免费额度即可），无构建步骤、依赖极少。

## 功能

- **卡片维护**：添加/编辑/归档信用卡，记录发卡行、尾号、账单日、还款日（支持「固定日」和「账单日+N 天」两种规则）、额度
- **月账单录入**：每卡每月一条账单金额，自动保存，月份可直接选择、标记已还/部分还款
- **年月统计**：12 个月柱状图、年度合计、各卡年度占比与月均
- **还款提醒**：仪表盘自动列出 7 天内到期与逾期账单（倒计时配色），标签页标题显示角标；只有未结清的账单会提醒
- **数据备份**：一键导出全量 CSV（含 BOM，Excel 直接打开不乱码）
- 密码登录（HMAC 签名 Cookie，30 天有效、自动续期）、深色模式、手机端适配

## 首次部署（4 步）

```bash
# 0. 进入项目目录，安装依赖
cd mycards && npm install

# 1. 创建 D1 数据库，把返回的 database_id 填入 wrangler.jsonc
npx wrangler d1 create mycards

# 2. 初始化线上数据表
npx wrangler d1 execute mycards --remote --file=schema.sql

# 3. 设置访问密码（会提示输入，务必用强密码）
npx wrangler secret put AUTH_PASSWORD

# 4. 部署
npx wrangler deploy
```

部署完成后 wrangler 会输出 `https://mycards.<你的子域>.workers.dev`，浏览器打开、输入密码即可使用。

## 本地开发

```bash
npm run db:init:local   # 初始化本地 D1（首次即可；本地开发密码在 .dev.vars 中自行设置）
npm run dev             # 启动 http://localhost:8787
```

本地数据存放在 `.wrangler/state/`，与线上完全隔离；想清空本地数据直接删掉该目录。

## 配置说明

| 配置 | 位置 | 说明 |
|---|---|---|
| 访问密码 | `wrangler secret put AUTH_PASSWORD` | 线上密码；本地开发在 `.dev.vars` |
| 时区 | `wrangler.jsonc` 的 `vars.TZ_OFFSET` | 「今天/本月」按此时区计算，默认北京时间 `8` |

## 数据备份与恢复

- **应用内导出**：仪表盘 / 统计页的「导出备份」按钮，下载全量 CSV
- **数据库级备份**：`npx wrangler d1 export mycards --remote --output=backup.sql`
- **恢复**：`npx wrangler d1 execute mycards --remote --file=backup.sql`

> D1 数据存在 Cloudflare，免费额度（每天 500 万行读、10 万行写）对个人使用绰绰有余，但建议定期导出备份。

## 安全说明

- 所有 `/api` 接口都需要登录；密码以 Cloudflare Secret 形式存储，不会出现在代码或配置里
- 会话 Cookie 为 HMAC-SHA256 签名（密钥经 HKDF 从密码派生），HttpOnly + Secure + SameSite=Lax，30 天有效，访问时不足 15 天自动续期
- 登录失败限速：同 IP 5 次失败锁 15 分钟；CSV 导出已中和公式注入前缀；删卡判断已原子化
- 若想更强保护，可在 Cloudflare 控制台为该域名叠加 [Zero Trust Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)（免费），应用层密码可保留作第二道防线

## 目录结构

```
mycards/
├── wrangler.jsonc        # Workers 配置（D1 绑定、静态资源、时区）
├── schema.sql            # 数据表
├── src/
│   ├── index.ts          # Hono 应用、登录/会话、路由挂载
│   ├── auth.ts           # Cookie 签发与校验
│   ├── util.ts           # 还款日推算、金额/日期工具
│   └── routes/
│       ├── cards.ts      # 卡片 CRUD（删除=归档）
│       ├── bills.ts      # 月账单录入、还款标记
│       └── stats.ts      # 仪表盘、年/月统计、CSV 导出
└── public/               # 前端单页（纯 HTML/CSS/JS，无构建）
```

## 统计口径说明

统计的是「账单金额」：某月合计 = 该月归属期（`period`）下所有账单金额之和。账单归属期以你录入时选择的月份为准（通常是账单日所在的月份），与银行账单周期可能相差几天，做趋势和合计足够用。
