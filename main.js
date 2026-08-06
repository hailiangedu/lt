// main.js - 完善版 PWA 注册与通知控制
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then(reg => {
        console.log('PWA Service Worker 注册成功，Scope:', reg.scope);

        // 请求系统通知权限
        if ('Notification' in window) {
          Notification.requestPermission().then(permission => {
            if (permission === 'granted') {
              console.log('用户已允许系统级通知');
              // 示例：注册成功并授权后，可通过 Service Worker 弹出一条测试通知
               //reg.showNotification('已允许系统级通知', {
                 //body: '系统级通知权限已获得',
                 //icon: 'image.png' // 可替换为您项目中的图标
               //});
            } else {
              console.log('用户拒绝了系统级通知权限');
            }
          });
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
