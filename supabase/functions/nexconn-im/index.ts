// ============================================================
// Edge Function: nexconn-im（站内私信 token 签发，契约 C1）
// 端点: POST /functions/v1/nexconn-im
// 鉴权: Supabase 平台级 JWT 校验开启（部署时不得加 --no-verify-jwt）
// 行为: 以 Supabase 用户 id 为 userId 调 NexConn Server API
//       注册/获取用户 token（幂等：同 userId 可多 token 并存），
//       返回 { token, userId, appKey } 供 chat.js 经 NCEngine.connect 使用
// NexConn API: POST {NEXCONN_API_BASE}/v4/auth/access-token/issue
//   签名: Signature = sha1(AppSecret + Nonce + Timestamp) 十六进制小写
//   头: App-Key / Nonce(<=18) / Timestamp(ms) / Signature
//   响应: { code: 0, result: { userId, accessToken } }
// 文档: docs.nexconn.ai/platform-chat-api（auth / user/register 节）
// ============================================================

const NEXCONN_API_BASE_DEFAULT = 'https://api.sg-light-api.com';

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// SHA1 十六进制小写（Server API 签名）
async function sha1Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-1', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// base64url 解码 JWT payload（平台已完成签名校验，这里只取 sub/email 供业务使用）
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const b64url = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const b64 = b64url + '='.repeat((4 - (b64url.length % 4)) % 4);
    const json = atob(b64);
    return JSON.parse(json);
  } catch (_e) {
    return null;
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method Not Allowed' }, 405);
  }

  // 1. JWT 鉴权（平台级 verify_jwt 已拦截非法 token；此处提取用户标识）
  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return jsonResponse({ error: '未登录或会话无效' }, 401);
  }
  const accessToken = authHeader.slice('Bearer '.length).trim();
  const payload = decodeJwtPayload(accessToken);
  const userId = payload ? (payload.sub as string | undefined) : undefined;
  if (!userId) {
    return jsonResponse({ error: '会话无效，请重新登录' }, 401);
  }

  // 2. 读取 secrets
  const appKey = Deno.env.get('NEXCONN_APP_KEY') || '';
  const appSecret = Deno.env.get('NEXCONN_APP_SECRET') || '';
  if (!appKey || !appSecret) {
    return jsonResponse({ error: 'IM 服务暂未配置（缺少 NEXCONN_APP_KEY/NEXCONN_APP_SECRET）' }, 502);
  }

  // 3. 调 NexConn Server API 注册/获取 token（幂等）
  try {
    const apiBase = (Deno.env.get('NEXCONN_API_BASE') || NEXCONN_API_BASE_DEFAULT).replace(/\/+$/, '');
    const nonce = Math.random().toString(36).slice(2, 14); // <=18 字符随机串
    const timestamp = String(Date.now());
    const signature = await sha1Hex(appSecret + nonce + timestamp);

    // name 必填（仅用于 NexConn 侧移动端推送展示）：取邮箱前缀兜底 userId
    const email = payload ? (payload.email as string | undefined) : undefined;
    const name = (email ? email.split('@')[0] : '') || userId;

    const res = await fetch(`${apiBase}/v4/auth/access-token/issue`, {
      method: 'POST',
      headers: {
        'App-Key': appKey,
        'Nonce': nonce,
        'Timestamp': timestamp,
        'Signature': signature,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId, name }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`nexconn-im: Server API HTTP ${res.status}`, text.slice(0, 300));
      return jsonResponse({ error: 'IM 凭证签发失败（NexConn Server API 错误）' }, 502);
    }

    const data = await res.json().catch(() => null);
    const token = data && data.result ? (data.result.accessToken as string | undefined) : undefined;
    if (!data || data.code !== 0 || !token) {
      console.error('nexconn-im: Server API 业务失败', JSON.stringify(data).slice(0, 300));
      return jsonResponse({ error: 'IM 凭证签发失败（NexConn 返回异常）' }, 502);
    }

    // 契约 C1 成功响应：{ token, userId, appKey }
    return jsonResponse({
      token,
      userId: (data.result.userId as string) || userId,
      appKey,
    });
  } catch (e) {
    console.error('nexconn-im: 调用异常', e);
    return jsonResponse({ error: 'IM 凭证服务暂时不可用' }, 502);
  }
});
