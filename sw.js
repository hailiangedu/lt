const CACHE_NAME = 'hailiang-forum-v7';
const assetsToCache = [
    './index.html',
    './bridge.html',
    './confirm.html',
    './feedback.html',
    './space.html',
    './checkin.html',
    './profile.html',
    './config.js',
    './common.js',
    './main.js',
    './index.js',
    './beijing.png',
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

// 3. 请求分层策略：同源静态资源 + jsdelivr CDN 白名单（Supabase SDK）stale-while-revalidate（缓存即时响应 + 后台静默更新），其余请求网络优先
self.addEventListener('fetch', event => {
    // 仅处理 http/https 请求
    if (!event.request.url.startsWith('http')) return;

    // 直接放行对 Supabase 边缘函数或其他外部 API 的请求，避免被缓存逻辑干扰
    if (event.request.url.includes('supabase.co')) {
        return;
    }

    // 同源静态资源（js/css/图片/图标/manifest 等）与 jsdelivr CDN 白名单资源（Supabase SDK）：stale-while-revalidate
    // 命中缓存立即返回（本地毫秒级响应），同时后台静默拉取最新版本写入缓存，下次访问生效
    const requestUrl = new URL(event.request.url);
    // 同源 + 静态扩展名
    const isSameOriginStatic = requestUrl.origin === self.location.origin &&
        /\.(js|mjs|css|png|jpe?g|gif|svg|webp|ico|json)$/.test(requestUrl.pathname);
    // jsdelivr 白名单（跨源）：域名 + 扩展名/包路径双重收窄——.js 资源与 @supabase/supabase-js 包
    // （SDK 引用 URL 形如 /npm/@supabase/supabase-js@2，不带 .js 后缀，故按包路径匹配；主版本升级 @2→@3 仍命中）
    const isJsdelivrWhitelisted = requestUrl.hostname === 'cdn.jsdelivr.net' &&
        (/\.js$/.test(requestUrl.pathname) || /^\/npm\/@supabase\/supabase-js(@|$)/.test(requestUrl.pathname));
    if (event.request.method === 'GET' && (isSameOriginStatic || isJsdelivrWhitelisted)) {
        event.respondWith(
            caches.match(event.request).then(cachedResponse => {
                if (cachedResponse) {
                    // 后台静默更新缓存：成功则下次访问生效，失败静默忽略，不影响本次已返回的缓存响应
                    fetch(event.request)
                        .then(networkResponse => {
                            if (networkResponse && networkResponse.status === 200) {
                                const responseClone = networkResponse.clone();
                                caches.open(CACHE_NAME).then(cache => {
                                    cache.put(event.request, responseClone);
                                });
                            }
                        })
                        .catch(() => {});
                    return cachedResponse;
                }
                // 缓存未命中：走网络，成功则写入缓存并返回，失败返回 404（沿用原有失败语义）
                return fetch(event.request)
                    .then(networkResponse => {
                        if (networkResponse && networkResponse.status === 200) {
                            const responseClone = networkResponse.clone();
                            caches.open(CACHE_NAME).then(cache => {
                                cache.put(event.request, responseClone);
                            });
                        }
                        return networkResponse;
                    })
                    .catch(() => {
                        return new Response('Network error or resource not found', {
                            status: 404,
                            statusText: 'Not Found'
                        });
                    });
            })
        );
        return;
    }

    // 其余请求（HTML 导航、跨源 CDN 等）：网络优先 + 缓存兜底（原有逻辑保持不变）
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
