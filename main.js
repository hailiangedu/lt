// main.js - 独立处理 PWA 注册逻辑
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