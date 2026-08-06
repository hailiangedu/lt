// main.js - 完善版 PWA 注册与 Web Push 订阅控制

// 辅助函数：将 VAPID 公钥转换为 Uint8Array
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

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js')
            .then(async reg => {
                console.log('PWA Service Worker 注册成功，Scope:', reg.scope);
                
                // 请求系统通知权限
                if ('Notification' in window) {
                    const permission = await Notification.requestPermission();
                    if (permission === 'granted') {
                        console.log('用户已允许系统级通知');
                        
                        // 自动向浏览器发起 Push 订阅
                        try {
                            // 替换为您生成的 VAPID 公钥 (PublicKey)
                            const publicVapidKey = 'BPHDsBQkG2EtjejqCXVPGCZa1j4yObdTYUODgNShebwXI7_UI4npmK6IPn370Dmc9cv9OMtHVYsiHVbnLypskGk';
                            
                            const subscription = await reg.pushManager.subscribe({
                                userVisibleOnly: true,
                                applicationServerKey: urlBase64ToUint8Array(publicVapidKey)
                            });
                            
                            console.log('Web Push 订阅成功:', subscription);
                            
                            // 如果您需要将 subscription 保存到 Supabase 数据库，可以在这里进行：
                            /*
                            const { data: { user } } = await supabase.auth.getUser();
                            if (user) {
                                await supabase.from('push_subscriptions').upsert({
                                    user_id: user.id,
                                    subscription: subscription
                                }, { onConflict: 'user_id' });
                            }
                            */
                        } catch (subErr) {
                            console.error('Web Push 订阅失败:', subErr);
                        }
                        
                    } else {
                        console.log('用户拒绝了系统级通知权限');
                    }
                }
            })
            .catch(err => {
                console.log('PWA Service Worker 注册失败:', err);
            });
    });
}

// 辅助方法：当用户登录成功后，将 userId 发送给 Service Worker 用于后台通知匹配
window.syncUserIdToSW = function(userId) {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
            type: 'SET_USER_ID',
            userId: userId
        });
    }
};
