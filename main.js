// main.js - 修复 supabase 未定义或异步加载延迟问题

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
                
                if ('Notification' in window) {
                    const permission = await Notification.requestPermission();
                    if (permission === 'granted') {
                        console.log('用户已允许系统级通知');
                        
                        try {
                            const publicVapidKey = 'BPHDsBQkG2EtjejqCXVPGCZa1j4yObdTYUODgNShebwXI7_UI4npmK6IPn370Dmc9cv9OMtHVYsiHVbnLypskGk';
                            
                            const subscription = await reg.pushManager.subscribe({
                                userVisibleOnly: true,
                                applicationServerKey: urlBase64ToUint8Array(publicVapidKey)
                            });
                            
                            console.log('Web Push 浏览器订阅成功:', subscription);

                            // 轮询等待全局 supabase 实例加载完成（最多等待 3 秒）
                            let client = window.supabase || (typeof supabase !== 'undefined' ? supabase : null);
                            let attempts = 0;
                            while (!client && attempts < 15) {
                                await new Promise(resolve => setTimeout(resolve, 200));
                                client = window.supabase || (typeof supabase !== 'undefined' ? supabase : null);
                                attempts++;
                            }

                            if (!client || !client.auth) {
                                console.error('错误: supabase 客户端加载超时，无法同步订阅到数据库！');
                                return;
                            }

                            // 获取当前登录用户
                            const { data: { user }, error: authError } = await client.auth.getUser();
                            
                            if (authError || !user) {
                                console.warn('用户未登录或登录状态已失效，无法将 push_subscription 写入数据库。请先登录论坛！');
                                return;
                            }

                            // 写入 push_subscriptions 表
                            const { error: dbError } = await client.from('push_subscriptions').upsert({
                                user_id: user.id,
                                subscription: subscription
                            }, { onConflict: 'user_id' });

                            if (dbError) {
                                console.error('写入 push_subscriptions 数据库失败:', dbError.message);
                            } else {
                                console.log('推送订阅凭证已成功同步至 Supabase 数据库！');
                            }

                        } catch (subErr) {
                            console.error('Web Push 订阅或落库过程出错:', subErr);
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

window.syncUserIdToSW = function(userId) {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
            type: 'SET_USER_ID',
            userId: userId
        });
    }
};
