// main.js - 独立处理 PWA 注册与安装拦截逻辑

let deferredPrompt = null;

// 1. 拦截浏览器的默认安装弹窗，获取安装控制权
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  console.log('PWA 安装事件已被代码拦截，已准备就绪');
});

// 2. 注册 Service Worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then(reg => {
        console.log('PWA Service Worker 注册成功，Scope:', reg.scope);
      })
      .catch(err => {
        console.log('PWA Service Worker 注册失败:', err);
      });
  });
}
