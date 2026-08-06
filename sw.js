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

// 2.激活阶段：清理旧版本的缓存（防止堆积无用文件）
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
        // 网络请求失败，尝试从本地缓存读取
        return caches.match(event.request).then(cachedResponse => {
          if (cachedResponse) {
            return cachedResponse;
          }
          // 如果缓存里也没有，且请求的是 HTML 页面，返回离线兜底提示
          if (event.request.headers.get('accept').includes('text/html')) {
            return caches.match('./index.html');
          }
        });
      })
  );
});

// ==================== 4. 系统级通知相关监听逻辑 ====================

// 监听来自服务器/边缘函数的主动推送事件 (Push Notification)
self.addEventListener('push', (event) => {
  let data = {
    title: '海高论坛',
    body: '您有一条新的通知',
    url: './index.html'
  };

  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body,
    icon: './icon.png',
    badge: './icon.png',
    data: { url: data.url || './index.html' }
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// 监听用户点击系统通知的行为
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      const targetUrl = event.notification.data.url || './index.html';
      
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          if (client.url !== targetUrl && 'navigate' in client) {
            return client.navigate(targetUrl);
          }
          return;
        }
      }
      
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
