const CACHE_NAME = 'hailiang-forum-v2';
const assetsToCache = [
    './index.html',
    './bridge.html',
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

// 3. 网络优先策略（Network First），带优雅兜底（已修复 POST 请求无法缓存的报错）
self.addEventListener('fetch', event => {
    // 仅处理 http/https 请求
    if (!event.request.url.startsWith('http')) return;

    // 直接放行对 Supabase 边缘函数或其他外部 API 的请求，避免被缓存逻辑干扰
    if (event.request.url.includes('supabase.co')) {
        return;
    }
    
    event.respondWith(
        fetch(event.request)
            .then(networkResponse => {
                // 如果网络请求成功，且请求方法是 GET，则克隆一份存入缓存并返回给页面
                if (networkResponse && networkResponse.status === 200 && event.request.method === 'GET') {
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
                    if (event.request.headers.get('accept') && event.request.headers.get('accept').includes('text/html')) {
                        return caches.match('./index.html');
                    }

                    return new Response('Network error or resource not found', {
                        status: 404,
                        statusText: 'Not Found'
                    });
                });
            })
    );
});

// ==================== 4. 系统级通知相关监听逻辑 ====================

// 监听来自后端边缘函数 (Web Push) 的主动推送事件
self.addEventListener('push', (event) => {
    let data = { 
        title: '海高论坛新通知', 
        body: '您有一条新的消息', 
        url: './index.html' 
    };

    if (event.data) {
        try {
            const payload = event.data.json();
            data.title = payload.title || data.title;
            data.body = payload.body || data.body;
            data.url = payload.url || data.url;
        } catch (e) {
            data.body = event.data.text();
        }
    }

    const options = {
        body: data.body,
        icon: './image.png',
        badge: './icon.png',
        vibrate: [200, 100, 200],
        data: { url: data.url }
    };

    // 核心：唤醒操作系统的系统级通知横幅
    event.waitUntil(
        self.registration.showNotification(data.title, options)
    );
});

// 监听用户点击系统通知的行为：点击后自动打开并强制以 PWA 独立窗口进入
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    
    // 给目标 URL 附带一个 PWA 独立运行标识
    let targetUrl = event.notification.data?.url || './index.html';
    const separator = targetUrl.includes('?') ? '&' : '?';
    const pwaUrl = targetUrl + separator + 'pwa_view=true';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
            // 1. 如果已经有打开的窗口，直接聚焦并导航
            for (let i = 0; i < windowClients.length; i++) {
                const client = windowClients[i];
                if (client.url.includes(self.location.origin) && 'focus' in client) {
                    client.focus();
                    return client.navigate(pwaUrl);
                }
            }
            // 2. 否则通过 openWindow 唤起（PWA 安装后系统会自动用独立应用壳打开）
            if (clients.openWindow) {
                return clients.openWindow(pwaUrl);
            }
        })
    );
});
