const CACHE_NAME = 'hailiang-forum-v5';

// 包含所有核心多页面和必要静态资源的缓存列表
const assetsToCache = [
  './index.html',
  './confirm.html',
  './feedback.html',
  './space.html',
  './main.js',
  './image.png',
  './icon.png',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

// 1. 安装阶段：缓存所有核心页面与资源
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        return cache.addAll(assetsToCache);
      })
      .then(() => self.skipWaiting())
  );
});

// 2. 激活阶段：清理旧版本的缓存（防止堆积无用文件）
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// 3. 网络优先策略（Network First），带优雅兜底
self.addEventListener('fetch', event => {
    // 仅处理 http/https 请求
    if (!event.request.url.startsWith('http')) return;

    event.respondWith(
        fetch(event.request)
            .then(networkResponse => {
                // 如果网络请求成功，克隆一份存入缓存，并返回给页面
                if (networkResponse && networkResponse.status === 200) {
                    const responseClone = networkResponse.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(event.request, responseClone);
                    });
                }
                return networkResponse;
            })
            .catch(() => {
                // 网络请求失败（如断网、弱网超时、偶发中断），尝试从本地缓存读取
                return caches.match(event.request).then(cachedResponse => {
                    if (cachedResponse) {
                        return cachedResponse;
                    }
                    
                    // 如果缓存里也没有，且用户请求的是 HTML 页面，可以返回一个预设的离线兜底提示
                    if (event.request.headers.get('accept').includes('text/html')) {
                        // 假设你缓存里有 index.html 或可以返回一个简单的错误提示
                        return caches.match('./index.html');
                    }
                });
            })
    );
});
// ==================== 4. 系统级通知相关监听逻辑 ====================

// 监听后台推送事件 (Push Notification)
self.addEventListener('push', (event) => {
  let data = { title: '新的消息', body: '您有一条来自海高论坛的新通知', url: './index.html' };
  
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body,
    icon: './icon.png',    // 对应仓库中的图标
    badge: './icon.png',
    data: {
      url: data.url || './index.html'
    }
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// 监听用户点击系统通知的行为
self.addEventListener('notificationclick', (event) => {
  event.notification.close(); // 关闭通知弹窗

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      const targetUrl = event.notification.data.url;
      
      // 如果已经有打开的窗口，则直接聚焦到该窗口并跳转/刷新到对应页面
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          if (client.url !== targetUrl && 'navigate' in client) {
            return client.navigate(targetUrl);
          }
          return;
        }
      }
      
      // 如果没有打开的窗口，则新建一个窗口打开目标链接
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
// sw.js - 在现有缓存策略基础上增加后台通知轮询逻辑

let activeUserId = null;
let lastCheckedNotificationId = null;

// 监听前端传来的用户 ID
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SET_USER_ID') {
    activeUserId = event.data.userId;
    console.log('Service Worker 已绑定用户 ID:', activeUserId);
  }
});

// 后台定时检查 Supabase 未读通知（实现真正的系统级后台通知）
// 注意：Service Worker 在后台运行时可以通过 fetch 直接请求公开的 Supabase API
setInterval(async () => {
  if (!activeUserId) return;

  try {
    // 通过 Supabase REST API 直接查询未读通知
    const SUPABASE_URL = 'https://snlikjcmuwkyibogfupy.supabase.co';
    const SUPABASE_ANON_KEY = 'sb_publishable_8stbmdXfZMtBGjwaq16ajw_KBDzE9ZW'; // 与 index.html 保持一致

    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/notifications?user_id=eq.${activeUserId}&is_read=eq.false&order=created_at.desc&limit=1`,
      {
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        }
      }
    );

    if (response.ok) {
      const notifications = await response.json();
      if (notifications && notifications.length > 0) {
        const latest = notifications[0];
        
        // 如果这是一条全新的未读通知（避免重复弹窗）
        if (latest.id !== lastCheckedNotificationId) {
          lastCheckedNotificationId = latest.id;

          // 触发真正意义上的系统级桌面通知
          self.registration.showNotification(latest.title || '海高论坛', {
            body: latest.content || '您有一条新的论坛消息',
            icon: './icon.png',
            badge: './icon.png',
            data: { url: './index.html' }
          });
        }
      }
    }
  } catch (err) {
    console.error('SW 后台检查通知出错:', err);
  }, 30000); // 每 30 秒在后台检查一次

// 监听用户点击系统通知的行为
self.addEventListener('notificationclick', (event) => {
  event.notification.close(); // 关闭通知弹窗

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      const targetUrl = event.notification.data.url;
      
      // 如果已经有打开的窗口，则聚焦
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          if (client.url !== targetUrl && 'navigate' in client) {
            return client.navigate(targetUrl);
          }
          return;
        }
      }
      
      // 如果网页完全关闭，则点击通知时自动唤起并打开论坛首页
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
