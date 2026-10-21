// common.js - 跨页共享工具层
// 依赖：config.js（window.LT_CONFIG）必须先于本文件加载；Supabase SDK 需已引入
// 契约见 spec/lt-refactor/plan.md "Contracts & Interfaces"
(function () {
    'use strict';

    // ---- 获取全局唯一 Supabase 客户端（懒创建全局单例并挂载 window.sbApp，幂等） ----
    function getSupabaseClient() {
        if (window.sbApp) return window.sbApp;
        if (window.supabase && window.LT_CONFIG) {
            window.sbApp = window.supabase.createClient(
                window.LT_CONFIG.SUPABASE_URL,
                window.LT_CONFIG.SUPABASE_ANON_KEY
            );
        }
        return window.sbApp || null;
    }

    // ---- HTML 转义（防存储型 XSS）：转义 & < > ' "；入参 null/undefined 返回空串 ----
    function escapeHtml(text) {
        if (text === null || text === undefined) return '';
        return String(text).replace(/[&<>'"]/g, function (ch) {
            return {
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                "'": '&#39;',
                '"': '&quot;'
            }[ch] || ch;
        });
    }

    // ---- 历史图片地址修复：错误域名/undefined 路径按配置规则修复；入参空值返回空串 ----
    function fixImageUrl(url) {
        if (!url) return '';
        const fixRules = (window.LT_CONFIG && window.LT_CONFIG.IMAGE_URL_FIX) || {};
        let fixed = String(url);
        if (fixRules.UNDEFINED_PATH_PATTERN) {
            fixed = fixed.replace(fixRules.UNDEFINED_PATH_PATTERN, fixRules.UNDEFINED_PATH_REPLACEMENT);
        }
        if (fixRules.OLD_DOMAIN) {
            fixed = fixed.replace(fixRules.OLD_DOMAIN, fixRules.NEW_DOMAIN || fixRules.OLD_DOMAIN);
        }
        return fixed;
    }

    // ---- 主题与自定义背景初始化（幂等；含系统暗色偏好回退与历史兼容键读取） ----
    function initThemeAndBackground() {
        // 1. 明暗主题：优先读取用户设置，未设置时回退系统偏好
        const savedTheme = localStorage.getItem('forum_theme');
        if (savedTheme === 'dark') {
            document.documentElement.setAttribute('data-theme', 'dark');
        } else if (savedTheme === 'light') {
            document.documentElement.removeAttribute('data-theme');
        } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
            document.documentElement.setAttribute('data-theme', 'dark');
        }

        // 2. 自定义背景：读取主键 forum_custom_bg，兼容历史遗留键 custom_bg/customBg/bg_image
        const customBg = localStorage.getItem('forum_custom_bg') ||
                         localStorage.getItem('custom_bg') ||
                         localStorage.getItem('customBg') ||
                         localStorage.getItem('bg_image');
        if (customBg) {
            document.body.style.backgroundImage = 'url("' + customBg + '")';
        } else {
            document.body.style.backgroundImage = "url('beijing.png')";
        }
    }

    // ---- 主题/背景跨页实时同步（storage 事件监听，幂等） ----
    function watchSettingsSync() {
        if (watchSettingsSync._installed) return;
        watchSettingsSync._installed = true;
        window.addEventListener('storage', function (event) {
            if (event.key === 'forum_theme') {
                if (event.newValue === 'dark') {
                    document.documentElement.setAttribute('data-theme', 'dark');
                } else {
                    document.documentElement.removeAttribute('data-theme');
                }
            } else if (['forum_custom_bg', 'custom_bg', 'customBg', 'bg_image'].indexOf(event.key) !== -1) {
                if (event.newValue) {
                    document.body.style.backgroundImage = 'url("' + event.newValue + '")';
                } else {
                    document.body.style.backgroundImage = "url('beijing.png')";
                }
            }
        });
    }

    // ---- 登录校验：未登录时提示并跳转，返回 session（已登录）或 null ----
    async function requireLogin(client, redirectTo, message) {
        if (!client) return null;
        const { data: { session } } = await client.auth.getSession();
        if (!session) {
            alert(message || '请先登录！');
            window.location.href = redirectTo || 'index.html';
            return null;
        }
        return session;
    }

    // ---- 挂载共享接口到 window，供各页面内联脚本与 main.js 消费 ----
    window.getSupabaseClient = getSupabaseClient;
    window.escapeHtml = escapeHtml;
    window.fixImageUrl = fixImageUrl;
    window.initThemeAndBackground = initThemeAndBackground;
    window.watchSettingsSync = watchSettingsSync;
    window.requireLogin = requireLogin;
})();
