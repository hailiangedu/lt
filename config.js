// config.js - 全局配置常量层（全库唯一的 Supabase 连接参数存放处）
// 加载方式：以同步普通 <script> 置于 <head> 中 Supabase SDK 之后、common.js 之前
window.LT_CONFIG = {
    // Supabase 项目地址与发布公钥（各页面统一通过 common.js 的 getSupabaseClient() 消费）
    SUPABASE_URL: 'https://snlikjcmuwkyibogfupy.supabase.co',
    SUPABASE_ANON_KEY: 'sb_publishable_8stbmdXfZMtBGjwaq16ajw_KBDzE9ZW',

    // 历史图片地址修复规则（收敛自 index.html 旧版渲染逻辑，规则语义保持不变）
    IMAGE_URL_FIX: {
        // 历史错误：图片地址曾以 `https://任意域名/undefined...` 形式存储，统一修复为 R2 正确域名
        UNDEFINED_PATH_PATTERN: /https?:\/\/[^\/]+\/undefined/,
        UNDEFINED_PATH_REPLACEMENT: 'https://hgwall.cc.cd',
        // 历史错误：旧图片域名需替换为新域名
        OLD_DOMAIN: 'hglt.cc.cd',
        NEW_DOMAIN: 'hgwall.cc.cd'
    }
};
