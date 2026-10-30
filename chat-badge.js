// chat-badge.js - 首页"消息"按钮未读徽标模块（US3，classic script，由 index.js 异步注入）
// 契约（plan.md D2/C6）：
//   window.LTChatBadge = { init(db, userId), cleanup() }
//   init:  查本人 im_unread_flags 行取初值（无行→隐藏）+ Supabase Realtime postgres_changes
//          订阅本人行变化，实时更新 #chat-unread-badge（红点+数字，0/无行隐藏，99+ 封顶）
//   cleanup: 断 Realtime 订阅、隐藏徽标、清内存（登出链路调用）
// 降级（FR-009）：DB 错误静默——徽标是增强功能，任何失败只隐藏徽标，不抛错不影响论坛主流程
(function () {
    'use strict';

    var BADGE_ID = 'chat-unread-badge';
    var channel = null;   // Realtime 订阅通道
    var currentUserId = null;

    function badgeEl() { return document.getElementById(BADGE_ID); }

    // ---- 徽标渲染：>0 显示数字（99+ 封顶），否则隐藏 ----
    function renderBadge(count) {
        var el = badgeEl();
        if (!el) return;
        var n = Number(count) || 0;
        if (n > 0) {
            el.textContent = n > 99 ? '99+' : String(n);
            el.classList.remove('hidden');
        } else {
            el.textContent = '';
            el.classList.add('hidden');
        }
    }

    // ---- 查本人行取初值（无行→隐藏；错误静默） ----
    async function loadInitial(db) {
        if (!db || !currentUserId) return;
        try {
            var res = await db.from('im_unread_flags').select('unread_count').eq('user_id', currentUserId).maybeSingle();
            if (res.error) return; // RLS 拒绝/网络异常：保持隐藏
            renderBadge(res.data ? res.data.unread_count : 0);
        } catch (e) { /* 静默 */ }
    }

    // ---- Realtime 订阅本人行（INSERT+UPDATE 事件；首行可能由 webhook EF service-role 写入，无 UPDATE 可听） ----
    function subscribe(db) {
        if (!db || !currentUserId || channel) return;
        try {
            channel = db.channel('lt-chat-badge-' + currentUserId)
                .on('postgres_changes',
                    { event: 'INSERT', schema: 'public', table: 'im_unread_flags', filter: 'user_id=eq.' + currentUserId },
                    function (payload) {
                        renderBadge(payload && payload.new ? payload.new.unread_count : 0);
                    })
                .on('postgres_changes',
                    { event: 'UPDATE', schema: 'public', table: 'im_unread_flags', filter: 'user_id=eq.' + currentUserId },
                    function (payload) {
                        renderBadge(payload && payload.new ? payload.new.unread_count : 0);
                    })
                .subscribe(function (status) {
                    // 订阅状态回调：仅确保失败时徽标保持既有展示，无需处理
                });
        } catch (e) {
            channel = null; // 订阅异常静默：徽标退化为静态初值
        }
    }

    window.LTChatBadge = {
        // 初始化（幂等）：登出后再登录同会话复用同一模块，重复 init 先清旧订阅
        init: function (db, userId) {
            try {
                if (!db || !userId) return;
                if (channel) { // 旧订阅清理（换号场景）
                    try { db.removeChannel(channel); } catch (e) { /* 静默 */ }
                    channel = null;
                }
                currentUserId = userId;
                renderBadge(0); // 初值隐藏，查库后再更新
                loadInitial(db);
                subscribe(db);
            } catch (e) { /* 静默 */ }
        },
        // 清理：断订阅 + 隐藏徽标 + 清内存（handleLogout 在 signOut 前调用）
        cleanup: function () {
            try {
                if (channel && window.sbApp) {
                    try { window.sbApp.removeChannel(channel); } catch (e) { /* 静默 */ }
                }
            } catch (e) { /* 静默 */ }
            channel = null;
            currentUserId = null;
            renderBadge(0);
        }
    };
})();
