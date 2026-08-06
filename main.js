// main.js - 独立处理 PWA 注册及系统通知逻辑
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
              // reg.showNotification('PWA 通知已激活', {
              //   body: '您的项目现在可以接收系统级通知了！',
              //   icon: 'beijing.png' // 可替换为您项目中的图标
              // });
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
