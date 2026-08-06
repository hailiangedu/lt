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

// 在 main.js 中追加或优化全局 Presence 逻辑
let globalPresenceChannel = null;

window.initGlobalPresence = async function(user) {
    if (!user || globalPresenceChannel) return;
    
    // 确保 Supabase 实例存在
    const client = window.sbApp || (window.supabase && window.supabase.createClient('https://snlikjcmuwkyibogfupy.supabase.co', 'sb_publishable_8stbmdXfZMtBGjwaq16ajw_KBDzE9ZW'));
    if (!client) return;

    try {
        globalPresenceChannel = client.channel('online-users', {
            config: {
                presence: {
                    key: user.id,
                },
            },
        });

        globalPresenceChannel.subscribe(async (status) => {
            if (status === 'SUBSCRIBED') {
                await globalPresenceChannel.track({
                    user_id: user.id,
                    online_at: new Date().toISOString(),
                });
                console.log('✅ 全局在线状态（Presence）已成功激活');
            }
        });
    } catch (e) {
        console.error('初始化全局 Presence 异常:', e);
    }
};
// --- 数据库心跳保活与全局在线状态机制 ---
let heartbeatTimer = null;

window.initUserHeartbeat = async function() {
    if (heartbeatTimer) return; // 避免重复启动

    // 确保 Supabase 客户端存在
    const client = window.sbApp || (window.supabase && window.supabase.createClient('https://snlikjcmuwkyibogfupy.supabase.co', 'sb_publishable_8stbmdXfZMtBGjwaq16ajw_KBDzE9ZW'));
    if (!client) return;

    try {
        const { data: { session } } = await client.auth.getSession();
        if (!session || !session.user) return;

        const userId = session.user.id;

        // 发送心跳函数：更新 profiles 表的 last_seen_at 为当前时间
        const sendHeartbeat = async () => {
            await client.from('profiles')
                .update({ last_seen_at: new Date().toISOString() })
                .eq('id', userId);
        };

        // 1. 页面加载后立即上报一次在线
        await sendHeartbeat();

        // 2. 每隔 25 秒自动上报一次心跳（小于离线判定阈值即可）
        heartbeatTimer = setInterval(sendHeartbeat, 25000);
        console.log('💓 用户数据库心跳保活已启动');
    } catch (err) {
        console.error('初始化心跳异常:', err);
    }
};

// 页面加载完成后自动触发心跳初始化
window.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
        if (typeof window.initUserHeartbeat === 'function') {
            window.initUserHeartbeat();
        }
    }, 600);
});
