const CACHE_NAME = 'hailiang-forum-v1';

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
    const url = new URL(event.request.url);

    // 如果请求的是图标，直接从缓存或本地稳妥返回指定的 image.png
    if (url.pathname.endsWith('/image.png') || url.pathname.endsWith('/icon.png')) {
      event.respondWith(
        caches.match(event.request).then(cached => {
          return cached || fetch(event.request);
        })
      );
      return;
    }
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
