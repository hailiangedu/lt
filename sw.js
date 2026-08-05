const CACHE_NAME = 'hailiang-forum-v1';

// 包含所有核心多页面和必要静态资源的缓存列表
const assetsToCache = [
  './index.html',
  './confirm.html',
  './feedback.html',
  './space.html',
  './main.js',
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

// 3. 请求拦截与缓存优先策略
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // 如果缓存中命中则直接返回，否则向网络发起请求
        return response || fetch(event.request).catch(() => {
          // 断网或弱网时的兜底处理（如果请求的是页面，可以返回离线提示等）
        });
      })
  );
});
