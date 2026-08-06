// main.js - 纯粹处理 PWA 注册与 Web Push 权限订阅

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

// 缓存全局订阅对象
window.globalPushSubscription = null;

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js')
            .then(async reg => {
                console.log('PWA Service Worker 注册成功');
                
                if ('Notification' in window) {
                    const permission = await Notification.requestPermission();
                    if (permission === 'granted') {
                        try {
                            const publicVapidKey = 'BPHDsBQkG2EtjejqCXVPGCZa1j4yObdTYUODgNShebwXI7_UI4npmK6IPn370Dmc9cv9OMtHVYsiHVbnLypskGk';
                            
                            // 向浏览器申请推送订阅
                            window.globalPushSubscription = await reg.pushManager.subscribe({
                                userVisibleOnly: true,
                                applicationServerKey: urlBase64ToUint8Array(publicVapidKey)
                            });
                            
                            console.log('Web Push 浏览器订阅成功:', window.globalPushSubscription);
                            
                            // 如果此时 index.html 的主逻辑已经就绪，尝试同步一次
                            if (typeof window.trySyncPushSubscription === 'function') {
                                window.trySyncPushSubscription();
                            }
                        } catch (err) {
                            console.error('Web Push 订阅失败:', err);
                        }
                    }
                }
            });
    });
}

window.syncUserIdToSW = function(userId) {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
            type: 'SET_USER_ID',
            userId: userId
        });
    }
};
// --- 全局在线状态（Supabase Presence）常驻逻辑 ---
let globalPresenceChannel = null;

window.initGlobalPresence = async function() {
    // 避免重复初始化
    if (globalPresenceChannel) return;
    
    // 确保 window.supabase 已加载且存在配置
    if (!window.supabase) return;

    const SUPABASE_URL = 'https://snlikjcmuwkyibogfupy.supabase.co';
    const SUPABASE_ANON_KEY = 'sb_publishable_8stbmdXfZMtBGjwaq16ajw_KBDzE9ZW';
    
    if (!window.sbGlobalApp) {
        window.sbGlobalApp = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }

    try {
        const { data: { session } } = await window.sbGlobalApp.auth.getSession();
        if (!session) return; // 未登录则不维护在线状态

        const currentUser = session.user;

        // 加入全局共享的在线用户频道
        globalPresenceChannel = window.sbGlobalApp.channel('online-users', {
            config: {
                presence: {
                    key: currentUser.id,
                },
            },
        });

        globalPresenceChannel.subscribe(async (status) => {
            if (status === 'SUBSCRIBED') {
                // 向频道广播当前用户的在线状态及时间戳，实现全局常驻在线
                await globalPresenceChannel.track({
                    user_id: currentUser.id,
                    online_at: new Date().toISOString(),
                });
                console.log('全局在线状态追踪已激活');
            }
        });
    } catch (e) {
        console.error('初始化全局 Presence 失败:', e);
    }
};

// 页面加载完成后自动尝试初始化全局在线状态
window.addEventListener('DOMContentLoaded', () => {
    // 延迟少许等待 Supabase SDK 加载完成
    setTimeout(() => {
        if (typeof window.initGlobalPresence === 'function') {
            window.initGlobalPresence();
        }
    }, 500);
});
