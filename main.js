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

let globalPushSubscription = null;

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
                            
                            // 订阅浏览器推送
                            globalPushSubscription = await reg.pushManager.subscribe({
                                userVisibleOnly: true,
                                applicationServerKey: urlBase64ToUint8Array(publicVapidKey)
                            });
                            
                            console.log('Web Push 浏览器订阅成功:', globalPushSubscription);
                            
                            // 如果此时页面上已经有了 supabase 且用户已登录，直接尝试同步一次
                            if (window.syncPushSubscriptionToSupabase) {
                                window.syncPushSubscriptionToSupabase();
                            }
                        } catch (err) {
                            console.error('Web Push 订阅失败:', err);
                        }
                    }
                }
            });
    });
}

// 暴露一个全局方法，供你的论坛登录成功逻辑调用
window.syncPushSubscriptionToSupabase = async function() {
    if (!globalPushSubscription) {
        console.log('浏览器推送尚未订阅完成');
        return;
    }
    
    // 获取当前页面中已有的 supabase 客户端
    const client = window.supabase || (typeof supabase !== 'undefined' ? supabase : null);
    if (!client || !client.auth) {
        console.warn('Supabase 客户端尚未初始化');
        return;
    }

    try {
        const { data: { user } } = await client.auth.getUser();
        if (user) {
            const { error } = await client.from('push_subscriptions').upsert({
                user_id: user.id,
                subscription: globalPushSubscription
            }, { onConflict: 'user_id' });

            if (error) {
                console.error('同步推送凭证到数据库失败:', error.message);
            } else {
                console.log('🎉 推送订阅凭证已成功同步至 Supabase 数据库！');
            }
        }
    } catch (e) {
        console.error('同步订阅异常:', e);
    }
};
