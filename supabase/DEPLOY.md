# 站内私信（NexConn IM）部署说明

本目录是"NexConn 站内私信"功能的服务端部署产物，站长手动部署（不入 CI）：

```text
supabase/
├── DEPLOY.md                                  # 本文件
├── migrations/
│   └── 20261030_im_unread_flags.sql           # 未读镜像表 + RLS + Realtime
└── functions/
    ├── nexconn-im/index.ts                    # Edge Function：IM token 签发（契约 C1）
    └── nexconn-webhook/index.ts               # Edge Function：消息 webhook → 未读镜像 + Web Push（契约 C2）
```

前端静态文件（chat.html / chat.js / chat-badge.js 及既有页面改动）随整包上传，见第 4 节。

---

## 1. Supabase 侧步骤

### 1.1 执行 migration SQL（建表 + RLS + Realtime）

Dashboard → **SQL Editor** → 新建查询 → 粘贴 `migrations/20261030_im_unread_flags.sql` 全文 → **Run**。

执行后核对：

- **Table Editor** 出现 `im_unread_flags`（3 列：user_id / unread_count / updated_at）；
- **Authentication → Policies**（或 Database → Policies）中该表 RLS 已启用，且有两条 policy：
  `im_unread_flags_select_own`、`im_unread_flags_update_own`（均 `auth.uid() = user_id`）；
- **Realtime 启用核对**：`replica identity full` 已设置、表已加入 `supabase_realtime` publication
  （可在 SQL Editor 执行 `select * from pg_publication_tables where tablename = 'im_unread_flags';` 应有一行；
  新版 Dashboard 也可在 Database → Publications 查看）。

### 1.2 部署两个 Edge Function

CLI 方式（推荐）：

```bash
# token 签发 EF：保持平台级 JWT 校验开启（默认，不加 --no-verify-jwt）
supabase functions deploy nexconn-im

# webhook 接收 EF：必须关闭平台级 JWT 校验（调用方是 NexConn 服务器，无 Supabase JWT）
supabase functions deploy nexconn-webhook --no-verify-jwt
```

> 无 CLI 时也可用 Dashboard → Edge Functions → New Function 粘贴对应 `index.ts` 内容，
> 并在 Settings 中确认 `nexconn-webhook` 的 **Verify JWT with Supabase Auth** 为关闭状态。

### 1.3 配置 Secrets

```bash
supabase secrets set \
  NEXCONN_APP_KEY=<NexConn App Key> \
  NEXCONN_APP_SECRET=<NexConn App Secret> \
  WEBHOOK_SECRET=<自定义随机串，用于 webhook ?secret= 鉴权> \
  VAPID_PUBLIC_KEY=<与 main.js 内置公钥配对的 VAPID 公钥> \
  VAPID_PRIVATE_KEY=<对应 VAPID 私钥>
```

> ⚠️ `SUPABASE_URL` 与 `SUPABASE_SERVICE_ROLE_KEY` 由平台**自动注入**所有 Edge Function，
> 无需（也无法）手动设置——Dashboard 会报 `Name must not start with the SUPABASE_ prefix`，属预期拦截。

Secrets 清单（两个 EF 共用同一 Secret 池，无归属区分）：

| Secret | 用途 | 必填 |
|---|---|---|
| `NEXCONN_APP_KEY` | NexConn Server API 签名头 `App-Key`（两个 EF 均用） | ✅ |
| `NEXCONN_APP_SECRET` | NexConn Server API 签名（sha1(secret+nonce+timestamp)） | ✅ |
| `WEBHOOK_SECRET` | webhook URL `?secret=` 防伪造比对 | ✅ |
| `VAPID_PUBLIC_KEY` | Web Push VAPID 公钥 | ✅ |
| `VAPID_PRIVATE_KEY` | Web Push VAPID 私钥 | ✅ |
| `SUPABASE_URL` | webhook EF 拼 PostgREST 地址 | ✅（平台自动注入，勿手动设置） |
| `SUPABASE_SERVICE_ROLE_KEY` | webhook EF 写 im_unread_flags / 读 profiles、push_subscriptions | ✅（平台自动注入，勿手动设置） |
| `NEXCONN_API_BASE` | Server API Base URL，默认 `https://api.sg-light-api.com`（新加坡）；选北美数据中心时设 `https://api.us-light-api.com` | 可选 |
| `VAPID_SUBJECT` | web-push subject，默认 `mailto:admin@hailiang-forum.local` | 可选 |

⚠️ **VAPID 密钥对必须与现有 main.js 中内置的公钥同对**（main.js 第 37 行
`BPHDsBQkG2EtjejqCXVPGCZa1j4yObdTYUODgNShebwXI7_UI4npmK6IPn370Dmc9cv9OMtHVYsiHVbnLypskGk`）。
VAPID 公私钥不配对会导致既有浏览器推送订阅全部验证失败（离线私信推送收不到）。

### 1.4 Realtime 启用核对（补充）

Supabase 新版控制台若提供 "Realtime → Tables" 开关，确认 `im_unread_flags` 处于启用状态
（1.1 的 SQL 已通过 publication 方式启用；两者任一生效即可，重复启用无副作用）。

---

## 2. NexConn 控制台步骤

1. 注册/登录 [NexConn 控制台](https://docs.nexconn.ai)（融云国际版），按套餐活动（10000 MAU）创建应用；
2. 记录 **App Key / App Secret**（→ 填入上节 secrets）；
3. **数据数据中心选择**：默认新加坡（`api.sg-light-api.com`，SDK 亦默认 SG，无需额外配置）；
   若选北美，除 `NEXCONN_API_BASE` 外还需在控制台确认客户端 SDK 区域一致；
4. **Webhook 回调登记**：Chat → Chat settings → Webhooks → Config：
   - URL：`https://<supabase-project-ref>.supabase.co/functions/v1/nexconn-webhook?secret=<WEBHOOK_SECRET>`
     （`?secret=` 拼在 URL 中即可，控制台无 secret 字段；EF 靠它做防伪造比对）
   - 事件：勾选 `message:send`（Message sent，Post-messaging webhook）
   - 保存。若服务器有入站 IP 白名单，放行 NexConn 的 Webhook 出口 IP
     （新加坡：52.221.93.74, 8.219.168.45, 8.219.93.148, 8.219.215.35, 8.219.43.97, 47.245.124.194,
     8.222.167.17, 47.236.149.1, 8.219.217.193, 8.222.202.67, 43.156.138.254, 43.163.81.196, 43.156.239.53；
     北美：52.41.206.152）。
   - 补充：NexConn **无 Web 端域名白名单**功能（已核对全部文档与控制台），无需配置生产域名。

---

## 3. 静态站整包上传（sw.js 部署纪律④）

本批部署 sw.js 与全部页面/JS/图标必须**同步上传，缺一即 SW install 预缓存失败、整批更新不生效**：

| 变更 | 文件 |
|---|---|
| 新增 | `chat.html`、`chat.js`、`chat-badge.js` |
| 修改 | `index.html`（顶栏"消息"按钮 + index.js 引用 ?v=2）、`index.js`（?v=2 内容：三处私聊入口 + 徽标注入/登出清理）、`profile.html`（发消息按钮）、`space.html`（发消息按钮）、`sw.js`（CACHE_NAME v10 + assetsToCache 22 项） |
| 零改动 | config.js / common.js / main.js / manifest.json / bridge.html / confirm.html / feedback.html / checkin.html |

上传清单核对（sw.js `assetsToCache` 22 项逐一存在）：
`index.html`、`bridge.html`、`confirm.html`、`feedback.html`、`space.html`、`checkin.html`、`profile.html`、
**`chat.html`**、`config.js?v=1`、`common.js?v=1`、`main.js?v=1`、**`index.js?v=2`**、
**`chat.js?v=1`**、**`chat-badge.js?v=1`**、`beijing.png`、`image.png`、`icon.png`、`icon-192.png`、
`icon-512.png`、`icon-192-maskable.png`、`icon-512-maskable.png`、`https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2`。

> NexConn SDK（`@nexconn/engine`、`@nexconn/chat`）**不入预缓存**，仅靠 jsdelivr SWR 分支运行时缓存（plan D1/D6）。

---

## 4. 站长部署后联调清单（plan.md D9）

前置：上述 Supabase / NexConn / 静态站三节全部完成。用两个测试账号（A、B）逐项验证：

- [ ] **双账号收发（US1/US2）**：A、B 互发消息——A 从 B 的个人主页/成员列表/帖子作者处点"发消息"，
      跳转 chat.html 并定位会话；发送文本后 B 在 2 秒内实时收到；会话列表显示头像/昵称/预览/时间/未读点；
      历史消息可向上翻页加载；
- [ ] **登录门（FR-012）**：未登录状态直接访问 chat.html 被引导回论坛登录；
- [ ] **未读徽标实时性（US3）**：A 停留在论坛首页（不进聊天页），B 发消息——
      A 顶部"消息"按钮红点未读数应不刷新页面即累加（Realtime）；A 进会话后未读清零；
- [ ] **离线推送（US4）**：A 订阅过浏览器通知后关闭 PWA，B 发消息——
      A 在 30 秒内收到含 B 昵称与内容预览的系统通知，点击直达 `chat.html?peer=<B>` 对应会话；
      A 在线（聊天页活跃）时 B 发消息不重复推送；
- [ ] **无凭证降级（FR-009）**：删除 secrets（或未部署 EF）时，chat.html 显示可重试错误态不白屏、
      论坛其余功能 100% 可用；徽标隐藏不报错；
- [ ] **登出清理（FR-008）**：首页登出后"消息"红点归零、订阅断开；换号登录不串号。

> 若联调中 token 签发 502：优先核对 `NEXCONN_APP_KEY/SECRET` 与控制台一致性、数据中心与
> `NEXCONN_API_BASE` 一致性；webhook 无反应：核对 URL `?secret=` 与 `WEBHOOK_SECRET`、
> `message:send` 事件是否勾选、Edge Function 日志（Dashboard → Edge Functions → Logs）。
