# 信用卡管家（mycards）

个人使用的信用卡管理小工具，部署在 Cloudflare Workers（免费额度即可），无构建步骤、依赖极少。

## 功能

- **卡片维护**：添加/编辑/归档信用卡，记录发卡行、尾号、账单日、还款日（支持「固定日」和「账单日+N 天」两种规则）、额度
- **月账单录入**：每卡每月一条账单金额，自动保存，月份可直接选择、标记已还/部分还款
- **年月统计**：12 个月柱状图、年度合计、各卡年度占比与月均
- **还款提醒**：仪表盘自动列出 7 天内到期与逾期账单（倒计时配色），标签页标题显示角标；只有未结清的账单会提醒
- **微信推送提醒**：每天北京时间 8 点、20 点，把还款日前 2 天内与逾期的未还账单发到邮箱（QQ 邮箱绑定微信/QQ 即为推送通知），无需打开网页
- **数据备份**：一键导出全量 CSV（含 BOM，Excel 直接打开不乱码）
- **PWA**：可「添加到主屏幕」像 App 一样全屏使用；静态资源离线缓存、秒开；断网时显示离线提示（数据始终以服务端为准，接口不缓存）
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
| 阿里云邮件推送 | `wrangler secret put` 4 项，见下节 | DirectMail 凭据与收发件地址，全部走 secret 不入仓库 |
| 定时触发 token | `wrangler secret put CRON_TOKEN` + GitHub 仓库 secret | 保护 `/api/cron`，两边必须是同一个值，见下节 |

## 还款提醒推送（邮箱）

每天北京时间 8 点、20 点，GitHub Actions 定时调用 Worker 的 `/api/cron`，把**还款日前 2 天、前 1 天、当天到期**以及**逾期未还**的账单合并成一封邮件，经[阿里云邮件推送 DirectMail](https://www.aliyun.com/product/directmail) 发到你的邮箱；QQ 邮箱开启新邮件提醒后即为微信/QQ 通知。没有临期账单则不发。标记「已还」后自动停止。

首次配置（5 步）：

```bash
# 1. 开通 DirectMail（选 cn-hangzhou 区域，代码里写死了该区域端点），
#    在「发信地址」里新建并验证一个发信地址，如 notify@你的域名
#    （需先在 Cloudflare DNS 加上它要求的 SPF/DKIM 记录）

# 2. 创建 RAM 子账号（重要：不要用主账号 AK！），只授予 AliyunDirectMailFullAccess 权限，
#    拿到 AccessKey ID / Secret，然后：
npx wrangler secret put DM_ACCESS_KEY_ID
npx wrangler secret put DM_ACCESS_KEY_SECRET

# 3. 发信地址与收件邮箱（QQ 邮箱）也走 secret，不进仓库：
npx wrangler secret put DM_FROM    # notify@你的域名
npx wrangler secret put MAIL_TO    # 你的QQ号@qq.com

# 4. 定时触发 token（保持两处一致）
openssl rand -hex 32
npx wrangler secret put CRON_TOKEN

# 5. GitHub 仓库 Secrets（Settings → Secrets and variables → Actions）：
#    CRON_TOKEN = 上面的随机 token
#    SITE_URL   = 生产地址（结尾不带斜杠）
```

装有 `gh` CLI 的话，GitHub 侧可用 `gh secret set <名字>` 代替网页操作。

验证：仓库 **Actions → Notify → Run workflow** 手动触发一次，步骤输出 `{"ok":true}` 即链路正常（无临期账单时不会收到邮件，属正常）。

注意事项：

- RAM 授权 `AliyunDirectMailFullAccess` 时，**资源范围必须选「账号级别」**——选「资源组级别」时，DirectMail 的资源不属于任何资源组，子账号调 API 会一直 403 Forbidden
- GitHub 定时任务在高峰期可能延迟几分钟，属官方已知行为
- 仓库 **60 天无任何活动** GitHub 会自动停用定时任务并发邮件提醒，访问仓库重新启用即可
- 不想发逾期账单的话，把 `src/notify.ts` 里的 `if (days > 2) continue;` 改成 `if (days > 2 || days < 0) continue;`
- DirectMail 免费额度每天 200 封，本用途每天最多 2 封，绰绰有余

## 数据备份与恢复

- **应用内导出**：仪表盘 / 统计页的「导出备份」按钮，下载全量 CSV
- **数据库级备份**：`npx wrangler d1 export mycards --remote --output=backup.sql`
- **恢复**：`npx wrangler d1 execute mycards --remote --file=backup.sql`

> D1 数据存在 Cloudflare，免费额度（每天 500 万行读、10 万行写）对个人使用绰绰有余，但建议定期导出备份。

## PWA 更新

Service Worker 会把静态资源缓存到浏览器本地，用户拿到新版本的时机由 `public/sw.js` 顶部的 `VERSION` 控制：

- **改了任何前端文件**（`index.html` / `app.js` / `style.css` / 图标 / manifest）后部署，必须把 `VERSION` 递增一档（`v1` → `v2`），否则老用户会一直用旧版本
- 新版本部署后，用户页面底部会弹出「发现新版本，点击更新」横幅，点击即切换到新版（数据不受影响，始终来自 D1）
- 本地开发（localhost）不注册 SW，缓存不会干扰调试；`/api/*` 任何情况下都不缓存

## 安全说明

- 除 `/api/cron`（用独立 token 鉴权，供 GitHub Actions 定时触发）外，所有 `/api` 接口都需要登录；密码以 Cloudflare Secret 形式存储，不会出现在代码或配置里
- 会话 Cookie 为 HMAC-SHA256 签名（密钥经 HKDF 从密码派生），HttpOnly + Secure + SameSite=Lax，30 天有效，访问时不足 15 天自动续期
- 登录失败限速：同 IP 5 次失败锁 15 分钟；CSV 导出已中和公式注入前缀；删卡判断已原子化
- 若想更强保护，可在 Cloudflare 控制台为该域名叠加 [Zero Trust Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)（免费），应用层密码可保留作第二道防线

## 目录结构

```
mycards/
├── wrangler.jsonc        # Workers 配置（D1 绑定、静态资源、时区）
├── schema.sql            # 数据表
├── .github/workflows/
│   ├── ci.yml            # push 时类型检查
│   └── notify.yml        # 每天 8/20 点（北京）触发还款提醒推送
├── src/
│   ├── index.ts          # Hono 应用、登录/会话、/api/cron、路由挂载
│   ├── auth.ts           # Cookie 签发与校验
│   ├── notify.ts         # DirectMail 提醒邮件（查询临期账单、签名发送）
│   ├── util.ts           # 还款日推算、金额/日期工具
│   └── routes/
│       ├── cards.ts      # 卡片 CRUD（删除=归档）
│       ├── bills.ts      # 月账单录入、还款标记
│       └── stats.ts      # 仪表盘、年/月统计、CSV 导出
└── public/               # 前端单页（纯 HTML/CSS/JS，无构建）
```

## 统计口径说明

统计的是「账单金额」：某月合计 = 该月归属期（`period`）下所有账单金额之和。账单归属期以你录入时选择的月份为准（通常是账单日所在的月份），与银行账单周期可能相差几天，做趋势和合计足够用。
