// ============================================================
// Edge Function: nexconn-webhook（NexConn 消息回调，契约 C2）
// 端点: POST /functions/v1/nexconn-webhook?secret=<WEBHOOK_SECRET>
// 部署: 必须加 --no-verify-jwt（调用方为 NexConn 服务器，无 Supabase JWT）
// 鉴权: query ?secret= 比对 WEBHOOK_SECRET；比对失败也返回 200（防 NexConn 重试风暴，仅记日志）
// 行为（仅 direct 会话 channelType===1，其余静默忽略）:
//   ① service role 将接收方 im_unread_flags.unread_count +1（upsert）
//   ② 经 NexConn Server API 查接收方连接状态——在线跳过推送（避免双通知）；
//     离线则查发送者昵称（profiles）+ 接收方订阅（push_subscriptions）→ web-push 发送
//     { title: 发送者昵称, body: 内容预览(~50字), url: './chat.html?peer=<发送者id>' }
//     （url 走既有 sw.js notificationclick 路由，零改动）
// 始终返回 2xx；异常仅记日志（FR-009 服务端镜像：失败可由 chat.js 校正自愈）
// NexConn 文档: docs.nexconn.ai/platform-chat-api（webhook / user connection-status 节）
// ============================================================

import webpush from 'npm:web-push@3.6.7';

const NEXCONN_API_BASE_DEFAULT = 'https://api.sg-light-api.com';
const PREVIEW_LEN = 50;

// Web Push 订阅结构（与 W3C PushSubscription JSON 序列化形态对齐；避免依赖 web-push 包内部类型导出）
interface PushSubscriptionLike {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

function ok(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function sha1Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-1', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---- NexConn Server API 签名请求头 ----
async function nexconnHeaders(): Promise<Record<string, string> | null> {
  const appKey = Deno.env.get('NEXCONN_APP_KEY') || '';
  const appSecret = Deno.env.get('NEXCONN_APP_SECRET') || '';
  if (!appKey || !appSecret) return null;
  const nonce = Math.random().toString(36).slice(2, 14); // <=18 字符随机串
  const timestamp = String(Date.now());
  const signature = await sha1Hex(appSecret + nonce + timestamp);
  return {
    'App-Key': appKey,
    'Nonce': nonce,
    'Timestamp': timestamp,
    'Signature': signature,
    'Content-Type': 'application/json',
  };
}

// ---- PostgREST（service role）快捷封装 ----
function restHeaders(): Record<string, string> {
  return {
    'apikey': Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
    'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''}`,
    'Content-Type': 'application/json',
    'Prefer': 'resolution=merge-duplicates',
  };
}

function restUrl(path: string): string {
  const base = (Deno.env.get('SUPABASE_URL') || '').replace(/\/+$/, '');
  return `${base}/rest/v1${path}`;
}

// ---- 消息文本提取（content 可能为 JSON 字符串 '{"content":"...","extra":""}' / 对象 / 纯文本） ----
function extractText(content: unknown): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') {
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).content === 'string') {
        return (parsed as Record<string, unknown>).content as string;
      }
    } catch (_e) { /* 纯文本直接返回 */ }
    return content;
  }
  if (typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    if (typeof obj.content === 'string') return obj.content;
    if (typeof obj.text === 'string') return obj.text;
  }
  return String(content);
}

// ---- 行为①：接收方未读 +1（upsert，service role 绕过 RLS） ----
async function bumpUnread(recipientId: string): Promise<void> {
  const selRes = await fetch(
    restUrl(`/im_unread_flags?select=unread_count&user_id=eq.${encodeURIComponent(recipientId)}`),
    { headers: restHeaders() },
  );
  if (!selRes.ok) {
    console.error(`nexconn-webhook: 查询 im_unread_flags 失败 HTTP ${selRes.status}`);
    return;
  }
  const rows = await selRes.json().catch(() => [] as unknown[]);
  if (Array.isArray(rows) && rows.length > 0) {
    const current = Number((rows[0] as Record<string, unknown>).unread_count) || 0;
    await fetch(
      restUrl(`/im_unread_flags?user_id=eq.${encodeURIComponent(recipientId)}`),
      {
        method: 'PATCH',
        headers: restHeaders(),
        body: JSON.stringify({ unread_count: current + 1, updated_at: new Date().toISOString() }),
      },
    );
  } else {
    await fetch(restUrl('/im_unread_flags'), {
      method: 'POST',
      headers: restHeaders(),
      body: JSON.stringify({ user_id: recipientId, unread_count: 1, updated_at: new Date().toISOString() }),
    });
  }
}

// ---- 行为②前置：接收方是否在线（NexConn 连接状态；查询失败按在线处理，避免重复推送） ----
async function isOnline(userId: string): Promise<boolean> {
  try {
    const headers = await nexconnHeaders();
    if (!headers) return true; // 未配置 Server API 凭证：跳过推送（不重复通知）
    const apiBase = (Deno.env.get('NEXCONN_API_BASE') || NEXCONN_API_BASE_DEFAULT).replace(/\/+$/, '');
    const res = await fetch(`${apiBase}/v4/user/connection-status/get`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ userId }),
    });
    if (!res.ok) return true; // 查询失败按在线：宁缺推送不重推送
    const data = await res.json().catch(() => null);
    if (!data || data.code !== 0) return true;
    const status = data.result && typeof data.result.status !== 'undefined' ? String(data.result.status) : '1';
    return status === '1'; // "1"=在线，"0"=离线
  } catch (_e) {
    return true; // 异常按在线：跳过推送
  }
}

// ---- 行为②：离线 Web Push（含发送者昵称 + 预览 + 会话直达 url） ----
async function sendPush(recipientId: string, senderId: string, preview: string): Promise<void> {
  const vapidPublic = Deno.env.get('VAPID_PUBLIC_KEY') || '';
  const vapidPrivate = Deno.env.get('VAPID_PRIVATE_KEY') || '';
  if (!vapidPublic || !vapidPrivate) return; // 未配置 VAPID：跳过推送

  // 发送者昵称（空回退论坛默认昵称规则）
  let nickname = '未命名用户';
  try {
    const profRes = await fetch(
      restUrl(`/profiles?select=nickname&id=eq.${encodeURIComponent(senderId)}`),
      { headers: restHeaders() },
    );
    if (profRes.ok) {
      const rows = await profRes.json().catch(() => [] as unknown[]);
      if (Array.isArray(rows) && rows.length > 0) {
        const nick = (rows[0] as Record<string, unknown>).nickname;
        if (typeof nick === 'string' && nick) nickname = nick;
      }
    }
  } catch (_e) { /* 回退默认昵称 */ }

  // 接收方浏览器推送订阅（无订阅则无推送）
  let subscription: Record<string, unknown> | null = null;
  try {
    const subRes = await fetch(
      restUrl(`/push_subscriptions?select=subscription&user_id=eq.${encodeURIComponent(recipientId)}`),
      { headers: restHeaders() },
    );
    if (subRes.ok) {
      const rows = await subRes.json().catch(() => [] as unknown[]);
      if (Array.isArray(rows) && rows.length > 0) {
        const sub = (rows[0] as Record<string, unknown>).subscription;
        if (sub && typeof sub === 'object') subscription = sub as Record<string, unknown>;
      }
    }
  } catch (_e) { /* 无订阅则跳过 */ }
  if (!subscription) return;

  // payload.url 为相对路径 './chat.html?peer=<发送者id>'：经既有 sw.js notificationclick 打开会话
  const body = preview.length > PREVIEW_LEN ? preview.slice(0, PREVIEW_LEN) + '…' : (preview || '收到一条新消息');
  const payload = JSON.stringify({
    title: `${nickname} 给你发来私信`,
    body,
    url: `./chat.html?peer=${senderId}`,
  });

  try {
    webpush.setVapidDetails(
      Deno.env.get('VAPID_SUBJECT') || 'mailto:admin@hailiang-forum.local',
      vapidPublic,
      vapidPrivate,
    );
    // 订阅失效（410 等）仅记日志：下次该用户上线 trySyncPushSubscription 会刷新订阅
    await webpush.sendNotification(subscription as unknown as PushSubscriptionLike, payload);
  } catch (e) {
    console.error('nexconn-webhook: web-push 发送失败', e instanceof Error ? e.message : e);
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  // 始终 2xx（防 NexConn 重试风暴）；所有异常仅记日志
  try {
    if (req.method !== 'POST') return ok(); // GET 等探活直接 200

    // 鉴权：query secret 比对（失败也 200，仅日志）
    const url = new URL(req.url);
    const secret = url.searchParams.get('secret') || '';
    const expected = Deno.env.get('WEBHOOK_SECRET') || '';
    if (!expected || secret !== expected) {
      console.error('nexconn-webhook: secret 校验失败，忽略本次回调');
      return ok();
    }

    const payload = await req.json().catch(() => null);
    if (!payload || typeof payload !== 'object') return ok();

    // NexConn Post-messaging webhook 信封：{ type: 'message:send', data: [ { userId, channelId, content, channelType, ... } ] }
    // 防御式兼容：data 为单对象或数组均处理
    const type = (payload as Record<string, unknown>).type;
    const rawData = (payload as Record<string, unknown>).data;
    const messages: unknown[] = Array.isArray(rawData)
      ? rawData
      : (rawData && typeof rawData === 'object' ? [rawData] : (Array.isArray(payload) ? payload : []));
    if (type && type !== 'message:send') return ok(); // 仅处理消息上行回调，其余类型静默确认

    for (const raw of messages) {
      if (!raw || typeof raw !== 'object') continue;
      const msg = raw as Record<string, unknown>;
      // 仅 direct 会话（channelType === 1）；群聊/系统频道静默忽略
      const channelType = msg.channelType;
      if (channelType !== 1 && String(channelType) !== '1') continue;

      const senderId = typeof msg.userId === 'string' ? msg.userId : String(msg.userId || '');
      const recipientId = typeof msg.channelId === 'string' ? msg.channelId : String(msg.channelId || '');
      if (!senderId || !recipientId || senderId === recipientId) continue;

      // ① 未读镜像 +1（失败仅日志，chat.js 校正自愈）
      try {
        await bumpUnread(recipientId);
      } catch (e) {
        console.error('nexconn-webhook: 未读镜像写入失败', e instanceof Error ? e.message : e);
      }

      // ② 在线抑制：在线（或状态未知）跳过推送；离线走 Web Push
      try {
        const online = await isOnline(recipientId);
        if (!online) {
          const preview = extractText(msg.content);
          await sendPush(recipientId, senderId, preview);
        }
      } catch (e) {
        console.error('nexconn-webhook: 推送流程异常', e instanceof Error ? e.message : e);
      }
    }
  } catch (e) {
    console.error('nexconn-webhook: 未预期异常', e instanceof Error ? e.message : e);
  }
  return ok();
});
