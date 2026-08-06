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
