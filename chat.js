// chat.js - 站内私信主逻辑（ESM module，经 chat.html 的 import map 解析 @nexconn/* 裸导入）
// 依赖：config.js / common.js（window.getSupabaseClient / escapeHtml / fixImageUrl / requireLogin）
// 契约：
//  - EF nexconn-im（契约 C1）：POST 返回 { token, userId, appKey }
//  - NexConn Web Chat SDK（docs.nexconn.ai/chatsdk-web）：
//    NCEngine.initialize/connect/disconnect、BaseChannel.createChannelsQuery/createMessagesQuery/getTotalUnreadCount、
//    new DirectChannel(peerId)、channel.clearUnreadCount()、new SendTextMessageParams({text}) + channel.sendMessage()
//  - im_unread_flags 为未读镜像表（plan D5）：NexConn 为权威源，chat.js 在连接/清未读/收到新消息时写校正
// 降级（FR-009）：EF 404/未部署/无凭证/SDK CDN 失败/连接失败 → 可重试错误态，绝不白屏

(function () {
    'use strict';

    var MAX_TEXT_LEN = 2000; // 单条文本上限（FR：超长提示不发）
    var HISTORY_PAGE_SIZE = 20;

    // ---- 全局状态 ----
    var state = {
        client: null,          // Supabase 客户端
        userId: null,          // 当前 Supabase 用户 id（即 NexConn userId）
        sdk: null,             // @nexconn/chat 命名空间（动态 import）
        engineReady: false,    // NCEngine.initialize 是否已执行
        handlersReady: false,  // 连接/消息监听器是否已注册
        connected: false,      // IM 是否已连接
        peerId: null,          // 当前打开会话的对端用户 id
        channel: null,         // 当前 DirectChannel 实例
        channels: new Map(),   // peerId -> 会话对象（SDK 返回或本地合成）
        profiles: new Map(),   // userId -> { id, nickname, avatar_url }
        earliestTime: null,    // 已加载最早消息时间戳（翻页用）
        historyExhausted: false,
        localMsgSeq: 0,
        sending: false
    };

    // ---- DOM 快捷取用 ----
    function el(id) { return document.getElementById(id); }

    // ---- 视图切换：登录门 / 错误态 / 骨架屏 / 主界面（互斥） ----
    function showView(name) {
        var map = {
            gate: 'chat-login-gate',
            error: 'chat-error',
            skeleton: 'chat-skeleton',
            main: 'chat-main'
        };
        Object.keys(map).forEach(function (k) {
            var node = el(map[k]);
            if (node) node.classList.toggle('hidden', k !== name);
        });
    }

    function showError(msg) {
        var errEl = el('chat-error-msg');
        if (errEl) errEl.textContent = msg || '聊天服务暂不可用，请稍后重试';
        showView('error');
    }

    function setStatus(text) {
        var node = el('conn-status');
        if (node) node.textContent = text || '';
    }

    // ---- 消息内容文本提取（防御式：content 可能是 JSON 字符串/对象/纯文本） ----
    function extractText(content) {
        if (content === null || content === undefined) return '';
        if (typeof content === 'string') {
            try {
                var parsed = JSON.parse(content);
                if (parsed && typeof parsed === 'object' && typeof parsed.content === 'string') return parsed.content;
            } catch (e) { /* 纯文本，直接返回 */ }
            return content;
        }
        if (typeof content === 'object') {
            if (typeof content.content === 'string') return content.content;
            if (typeof content.text === 'string') return content.text;
        }
        return String(content);
    }

    // ---- SDK 返回数据提取（兼容 res.data 为数组或 { data: [...] } 两种形态） ----
    function extractArray(data) {
        if (Array.isArray(data)) return data;
        if (data && Array.isArray(data.data)) return data.data;
        if (data && Array.isArray(data.list)) return data.list;
        return [];
    }

    // ---- 是否单聊频道/消息（channelType === 1 为单聊） ----
    function isDirect(type) {
        if (type === 1 || String(type) === '1') return true;
        try {
            var ct = state.sdk && state.sdk.ChannelType;
            if (ct && type !== undefined && type !== null && String(type) === String(ct.DIRECT)) return true;
        } catch (e) { /* 枚举不存在时忽略 */ }
        return false;
    }

    // ---- 头像地址（白名单校验 + 历史地址修复 + 兜底 icon.png） ----
    function avatarUrl(profile) {
        var url = window.fixImageUrl(profile && profile.avatar_url);
        if (!url || !/^(data:image\/|https?:)/.test(url)) return 'icon.png';
        return url;
    }

    function displayName(profile) {
        var name = profile && profile.nickname;
        return name ? String(name) : '未命名用户';
    }

    // ---- 时间格式化：今日显示 HH:MM，否则 M-DD ----
    function formatTime(ts) {
        var n = Number(ts);
        if (!ts || isNaN(n)) return '';
        var d = new Date(n);
        if (isNaN(d.getTime())) return '';
        var now = new Date();
        function pad(x) { return x < 10 ? '0' + x : '' + x; }
        if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
            return pad(d.getHours()) + ':' + pad(d.getMinutes());
        }
        return (d.getMonth() + 1) + '-' + pad(d.getDate());
    }

    // ---- 获取/缓存用户资料（单条，带内存缓存） ----
    async function fetchProfile(userId) {
        if (state.profiles.has(userId)) return state.profiles.get(userId);
        var profile = null;
        try {
            var res = await state.client.from('profiles').select('id, nickname, avatar_url').eq('id', userId).maybeSingle();
            if (!res.error && res.data) profile = res.data;
        } catch (e) { /* 静默：资料缺失时按默认展示 */ }
        if (!profile) profile = { id: userId, nickname: '', avatar_url: '' };
        state.profiles.set(userId, profile);
        return profile;
    }

    // ---- 批量获取用户资料（会话列表用） ----
    async function fetchProfiles(ids) {
        var missing = ids.filter(function (id) { return !state.profiles.has(id); });
        if (missing.length > 0) {
            try {
                var res = await state.client.from('profiles').select('id, nickname, avatar_url').in('id', missing);
                if (!res.error && res.data) {
                    res.data.forEach(function (p) { state.profiles.set(p.id, p); });
                }
            } catch (e) { /* 静默 */ }
        }
    }

    // ============================================================
    // 未读镜像表 im_unread_flags 校正写入（plan D5/D2，T014）
    // RLS 仅开放 SELECT/UPDATE：先 UPDATE 自有行，0 行命中再尝试 INSERT（INSERT 可能被 RLS 拒绝，静默失败可接受）
    // ============================================================
    async function correctUnreadFlag(count) {
        if (!state.client || !state.userId) return;
        var now = new Date().toISOString();
        try {
            var upd = await state.client.from('im_unread_flags')
                .update({ unread_count: count, updated_at: now })
                .eq('user_id', state.userId);
            if (upd.error) return;
            if (!upd.data || upd.data.length === 0) {
                await state.client.from('im_unread_flags')
                    .insert({ user_id: state.userId, unread_count: count, updated_at: now });
            }
        } catch (e) { /* 镜像失败不影响聊天主流程 */ }
    }

    async function incrementUnreadFlag() {
        if (!state.client || !state.userId) return;
        try {
            var sel = await state.client.from('im_unread_flags').select('unread_count').eq('user_id', state.userId).maybeSingle();
            if (sel.error) return;
            if (sel.data) {
                await state.client.from('im_unread_flags')
                    .update({ unread_count: (Number(sel.data.unread_count) || 0) + 1, updated_at: new Date().toISOString() })
                    .eq('user_id', state.userId);
            } else {
                await state.client.from('im_unread_flags')
                    .insert({ user_id: state.userId, unread_count: 1, updated_at: new Date().toISOString() });
            }
        } catch (e) { /* 静默 */ }
    }

    // ---- 未读总数（NexConn 权威源），失败时回退会话列表求和 ----
    async function totalUnread() {
        try {
            var res = await state.sdk.BaseChannel.getTotalUnreadCount();
            if (res && res.code === 0 && typeof res.data === 'number') return res.data;
        } catch (e) { /* 回退列表求和 */ }
        var sum = 0;
        state.channels.forEach(function (ch) { sum += Number(ch.unreadCount) || 0; });
        return sum;
    }

    // ============================================================
    // 会话列表（T006）
    // ============================================================
    async function loadConversationList() {
        var loading = el('conv-loading');
        var listBox = el('conversation-list');
        if (loading) loading.classList.remove('hidden');
        try {
            var query = state.sdk.BaseChannel.createChannelsQuery({ pageSize: 50 });
            var res = await query.loadNextPage();
            if (!res || res.code !== 0) {
                if (loading) loading.classList.add('hidden');
                if (listBox) listBox.innerHTML = '<p style="font-size:12px;color:var(--meta-color);text-align:center;padding:12px 0;margin:0;">会话加载失败</p>';
                return;
            }
            var all = extractArray(res.data);
            state.channels = new Map();
            all.forEach(function (ch) {
                if (!ch || !isDirect(ch.channelType)) return; // 仅单聊（群聊/系统频道不入列）
                var peerId = ch.channelId !== undefined && ch.channelId !== null ? String(ch.channelId) : '';
                if (!peerId || peerId === String(state.userId)) return;
                state.channels.set(peerId, ch);
            });
            await fetchProfiles(Array.from(state.channels.keys()));
            renderConversationList();
        } catch (e) {
            if (loading) loading.classList.add('hidden');
            if (listBox) listBox.innerHTML = '<p style="font-size:12px;color:var(--meta-color);text-align:center;padding:12px 0;margin:0;">会话加载失败</p>';
        }
    }

    function renderConversationList() {
        var loading = el('conv-loading');
        var listBox = el('conversation-list');
        var emptyBox = el('conv-empty');
        if (loading) loading.classList.add('hidden');
        if (!listBox) return;
        listBox.innerHTML = '';
        var entries = Array.from(state.channels.values());
        entries.sort(function (a, b) {
            return (Number(b.operationTime) || 0) - (Number(a.operationTime) || 0);
        });
        if (emptyBox) emptyBox.classList.toggle('hidden', entries.length !== 0);
        entries.forEach(function (ch) {
            var peerId = String(ch.channelId);
            var profile = state.profiles.get(peerId);
            var unread = Number(ch.unreadCount) || 0;
            var preview = extractText(ch.latestMessage && ch.latestMessage.content);
            var item = document.createElement('div');
            item.className = 'conv-item';
            item.setAttribute('data-peer', peerId);

            var img = document.createElement('img');
            img.className = 'conv-avatar';
            img.src = avatarUrl(profile);
            img.alt = '';
            img.loading = 'lazy';

            var main = document.createElement('div');
            main.className = 'conv-main';
            var top = document.createElement('div');
            top.className = 'conv-top';
            var name = document.createElement('span');
            name.className = 'conv-name';
            name.textContent = displayName(profile);
            var time = document.createElement('span');
            time.className = 'conv-time';
            time.textContent = formatTime(ch.latestMessage && ch.latestMessage.sentTime || ch.operationTime);
            top.appendChild(name);
            top.appendChild(time);
            var prev = document.createElement('div');
            prev.className = 'conv-preview';
            prev.textContent = preview ? (preview.length > 40 ? preview.slice(0, 40) + '…' : preview) : '暂无消息';
            main.appendChild(top);
            main.appendChild(prev);

            item.appendChild(img);
            item.appendChild(main);
            if (unread > 0) {
                var badge = document.createElement('span');
                badge.className = 'conv-unread';
                badge.textContent = unread > 99 ? '99+' : String(unread);
                item.appendChild(badge);
            }
            item.addEventListener('click', function () { openConversation(peerId); });
            listBox.appendChild(item);
        });
    }

    // ============================================================
    // 消息视图（T008）
    // ============================================================
    function ensureChannel(peerId) {
        var existing = state.channels.get(peerId);
        if (existing && existing._directChannel) return existing._directChannel;
        var channel = new state.sdk.DirectChannel(peerId);
        if (existing) {
            existing._directChannel = channel;
        } else {
            state.channels.set(peerId, {
                channelId: peerId, channelType: 1, unreadCount: 0,
                latestMessage: null, operationTime: Date.now(), _directChannel: channel
            });
        }
        return channel;
    }

    async function openConversation(peerId) {
        peerId = String(peerId || '');
        if (!peerId) return;
        if (peerId === String(state.userId)) return; // 不能与自己私聊
        var profile = await fetchProfile(peerId);

        state.peerId = peerId;
        state.channel = ensureChannel(peerId);
        state.earliestTime = null;
        state.historyExhausted = false;

        var header = el('msg-header');
        var peerName = el('msg-peer-name');
        var placeholder = el('msg-placeholder');
        var content = el('msg-content');
        var notice = el('msg-notice');
        var list = el('msg-list');
        var earlierBtn = el('load-earlier-btn');
        if (peerName) peerName.textContent = displayName(profile);
        if (header) header.classList.remove('hidden');
        if (placeholder) placeholder.classList.add('hidden');
        if (content) content.classList.remove('hidden');
        if (notice) notice.classList.add('hidden');
        if (list) list.innerHTML = '';
        if (earlierBtn) earlierBtn.classList.add('hidden');

        // 移动端：切入消息视图
        var main = el('chat-main');
        if (main) main.classList.add('show-msg');

        await loadHistory(true);

        // 清除该会话未读（NexConn 权威）+ 镜像表校正（T014）
        try { await state.channel.clearUnreadCount(); } catch (e) { /* 静默 */ }
        var ch = state.channels.get(peerId);
        if (ch) ch.unreadCount = 0;
        renderConversationList();
        var total = await totalUnread();
        correctUnreadFlag(total);
    }

    function closeConversationView() {
        var main = el('chat-main');
        if (main) main.classList.remove('show-msg');
        state.peerId = null;
        state.channel = null;
    }

    async function loadHistory(scrollBottom) {
        var list = el('msg-list');
        var scroll = el('msg-scroll');
        var hint = el('history-loading-hint');
        var earlierBtn = el('load-earlier-btn');
        if (!list || !state.channel) return;
        if (state.historyExhausted && !scrollBottom) return;
        if (hint) hint.classList.remove('hidden');
        if (earlierBtn) earlierBtn.classList.add('hidden');
        try {
            var query = state.sdk.BaseChannel.createMessagesQuery({
                channelIdentifier: state.channel.identifier,
                // 翻页起点取已加载最早时间-1，避免边界消息重复上屏（首屏从当前时间开始）
                startTime: state.earliestTime !== null ? state.earliestTime - 1 : Date.now(),
                pageSize: HISTORY_PAGE_SIZE,
                isAscending: false // 最新在前
            });
            var res = await query.loadNextPage();
            if (!res || res.code !== 0) {
                if (list.childElementCount === 0) {
                    list.innerHTML = '<p style="font-size:12px;color:var(--meta-color);text-align:center;padding:16px 0;margin:0;">消息加载失败</p>';
                }
            } else {
                var messages = extractArray(res.data);
                if (messages.length < HISTORY_PAGE_SIZE) state.historyExhausted = true;
                // 空列表时清掉错误占位
                if (list.firstElementChild && list.firstElementChild.tagName === 'P') list.innerHTML = '';
                var oldHeight = scroll ? scroll.scrollHeight : 0;
                // 倒序逐条 prepend：最终自上而下为 旧 → 新
                for (var i = 0; i < messages.length; i++) {
                    var m = messages[i];
                    var sent = Number(m.sentTime);
                    if (sent && (state.earliestTime === null || sent < state.earliestTime)) state.earliestTime = sent;
                    list.insertBefore(buildMessageRow(m), list.firstChild);
                }
                if (scrollBottom) {
                    scroll.scrollTop = scroll.scrollHeight;
                } else if (scroll) {
                    scroll.scrollTop = scroll.scrollHeight - oldHeight; // 保持视口位置
                }
                if (list.childElementCount === 0) {
                    list.innerHTML = '<p style="font-size:12px;color:var(--meta-color);text-align:center;padding:16px 0;margin:0;">你们还不是好友？打个招呼吧 👋</p>';
                }
            }
        } catch (e) {
            if (list.childElementCount === 0) {
                list.innerHTML = '<p style="font-size:12px;color:var(--meta-color);text-align:center;padding:16px 0;margin:0;">消息加载失败</p>';
            }
        }
        if (hint) hint.classList.add('hidden');
        if (earlierBtn) earlierBtn.classList.toggle('hidden', state.historyExhausted);
    }

    // ---- 气泡行构建（DOM API + textContent，防存储型 XSS） ----
    function buildMessageRow(m, localMeta) {
        var mine = String(m.senderUserId) === String(state.userId);
        var row = document.createElement('div');
        row.className = 'msg-row ' + (mine ? 'mine' : 'theirs');

        var avatar = document.createElement('img');
        avatar.className = 'msg-avatar';
        var senderProfile = state.profiles.get(String(m.senderUserId));
        avatar.src = mine ? 'icon.png' : avatarUrl(senderProfile);
        avatar.alt = '';

        var body = document.createElement('div');
        body.className = 'msg-body';
        var bubble = document.createElement('div');
        bubble.className = 'msg-bubble';
        bubble.textContent = extractText(m.content);
        var meta = document.createElement('div');
        meta.className = 'msg-meta';
        meta.textContent = formatTime(m.sentTime);

        body.appendChild(bubble);
        body.appendChild(meta);
        row.appendChild(avatar);
        row.appendChild(body);

        // 本地乐观发送态：发送中标记，成败由 settleLocalBubble 收尾（T008 失败气泡重试）
        if (localMeta) {
            row.setAttribute('data-local-id', localMeta.id);
            var status = document.createElement('span');
            status.className = 'msg-meta msg-local-status';
            status.textContent = '发送中...';
            body.appendChild(status);
        }
        return row;
    }

    // ---- 乐观气泡收尾：成功去标记 / 失败转可点击重试 ----
    function settleLocalBubble(localId, ok, text) {
        var list = el('msg-list');
        if (!list) return;
        var row = list.querySelector('[data-local-id="' + localId + '"]');
        if (!row) return;
        var status = row.querySelector('.msg-local-status');
        if (ok) {
            if (status) status.remove();
            row.removeAttribute('data-local-id');
        } else if (status) {
            status.classList.remove('msg-local-status');
            status.classList.add('msg-status-failed');
            status.textContent = '发送失败，点击重试';
            status.title = '重发这条消息';
            status.addEventListener('click', function () {
                removeBubble(localId);
                doSendText(text);
            });
        }
    }

    function removeBubble(localId) {
        var list = el('msg-list');
        if (!list) return;
        var row = list.querySelector('[data-local-id="' + localId + '"]');
        if (row) row.remove();
    }

    function showNotice(text) {
        var notice = el('msg-notice');
        if (!notice) return;
        notice.textContent = text;
        notice.classList.remove('hidden');
        setTimeout(function () { notice.classList.add('hidden'); }, 3000);
    }

    // ---- 发送文本（乐观 UI + 失败重试） ----
    async function doSendText(text) {
        if (!state.channel || state.sending) return;
        text = String(text || '').trim();
        if (!text) return;
        if (text.length > MAX_TEXT_LEN) { showNotice('单条消息不能超过 ' + MAX_TEXT_LEN + ' 字'); return; }

        state.sending = true;
        var localId = 'local-' + Date.now() + '-' + (++state.localMsgSeq);
        var list = el('msg-list');
        var scroll = el('msg-scroll');
        var fake = { senderUserId: state.userId, content: text, sentTime: Date.now() };
        var row = buildMessageRow(fake, { id: localId, pending: true });
        if (list) {
            if (list.firstElementChild && list.firstElementChild.tagName === 'P') list.innerHTML = '';
            list.appendChild(row);
        }
        if (scroll) scroll.scrollTop = scroll.scrollHeight;
        try {
            var params = new state.sdk.SendTextMessageParams({ text: text });
            var res = await state.channel.sendMessage(params);
            if (res && res.code === 0) {
                settleLocalBubble(localId, true, text);
            } else {
                settleLocalBubble(localId, false, text);
            }
        } catch (e) {
            settleLocalBubble(localId, false, text);
        }
        state.sending = false;
    }

    function onSendClick() {
        var input = el('msg-input');
        if (!input) return;
        // 发送中/未打开会话：不取走输入内容（避免丢字），直接忽略本次点击
        if (state.sending || !state.channel) return;
        var text = input.value;
        input.value = '';
        doSendText(text);
    }

    // ============================================================
    // SDK 实时消息 / 连接状态监听（注册一次）
    // ============================================================
    function installHandlers() {
        if (state.handlersReady || !state.sdk) return;
        state.handlersReady = true;
        try {
            state.sdk.NCEngine.addConnectionStatusHandler('lt-chat-conn', new state.sdk.ConnectionStatusHandler({
                onConnectionStatusChanged: function (info) {
                    var s = info && info.status;
                    if (s === 2 || String(s) === '2' || s === 'connected') {
                        state.connected = true;
                        setStatus('已连接');
                    } else if (s === 1 || String(s) === '1' || s === 'connecting') {
                        setStatus('连接中...');
                    } else {
                        state.connected = false;
                        setStatus('连接已断开，消息可能延迟');
                    }
                }
            }));
            state.sdk.NCEngine.addMessageHandler('lt-chat-msg', new state.sdk.MessageHandler({
                onMessageReceived: function (info) {
                    var messages = (info && info.messages) || [];
                    messages.forEach(handleIncomingMessage);
                },
                onOfflineMessageSyncCompleted: function () {
                    // 离线消息同步完成后刷新列表与未读镜像
                    loadConversationList().then(function () {
                        totalUnread().then(correctUnreadFlag);
                    });
                }
            }));
        } catch (e) { /* 监听注册失败不阻断主流程 */ }
    }

    function handleIncomingMessage(m) {
        if (!m || !isDirect(m.channelType)) return;
        var peerId = String(m.senderUserId || m.channelId || '');
        if (!peerId || peerId === String(state.userId)) return;
        fetchProfile(peerId).then(function () {
            // 当前会话正在与该对端聊天：直接上屏 + 清未读
            if (state.peerId === peerId && state.channel) {
                var list = el('msg-list');
                var scroll = el('msg-scroll');
                if (list) {
                    if (list.firstElementChild && list.firstElementChild.tagName === 'P') list.innerHTML = '';
                    list.appendChild(buildMessageRow(m));
                }
                if (scroll) scroll.scrollTop = scroll.scrollHeight;
                try { state.channel.clearUnreadCount(); } catch (e) { /* 静默 */ }
            } else {
                incrementUnreadFlag(); // 镜像 +1（首页徽标实时性，T014）
            }
            // 更新会话列表条目（置顶 + 预览 + 未读）
            var ch = state.channels.get(peerId);
            if (ch) {
                ch.latestMessage = m;
                ch.operationTime = Number(m.sentTime) || Date.now();
                if (state.peerId !== peerId) ch.unreadCount = (Number(ch.unreadCount) || 0) + 1;
            } else {
                state.channels.set(peerId, {
                    channelId: peerId, channelType: 1,
                    unreadCount: state.peerId === peerId ? 0 : 1,
                    latestMessage: m, operationTime: Number(m.sentTime) || Date.now()
                });
            }
            renderConversationList();
        });
    }

    // ============================================================
    // 连接主流程：token 获取（含 sessionStorage 缓存）→ SDK 动态加载 → initialize → connect
    // 任何一步失败：清除 token 缓存并展示可重试错误态（FR-009）
    // ============================================================
    async function fetchImToken() {
        var cached = null;
        try { cached = JSON.parse(sessionStorage.getItem('forum_chat_token') || 'null'); } catch (e) { cached = null; }
        // FR-008 防串号：缓存 token 必须属于当前登录用户——同标签页换号登录时旧 token 弃用并清除，强制走 EF 重签
        if (cached && cached.token && cached.appKey && String(cached.userId) === String(state.userId)) return cached;
        if (cached) { try { sessionStorage.removeItem('forum_chat_token'); } catch (e) { /* 忽略 */ } }

        var res = await state.client.functions.invoke('nexconn-im');
        if (res.error) {
            var msg = res.error && res.error.message ? res.error.message : 'IM 凭证获取失败';
            throw new Error(msg);
        }
        var data = res.data;
        if (!data || !data.token || !data.appKey) {
            throw new Error('IM 凭证返回异常');
        }
        var payload = { token: data.token, appKey: data.appKey, userId: String(state.userId) };
        try { sessionStorage.setItem('forum_chat_token', JSON.stringify(payload)); } catch (e) { /* 隐私模式忽略 */ }
        return payload;
    }

    async function connectIm() {
        showView('skeleton');
        setStatus('正在连接聊天服务...');

        // 1. token（EF 契约 C1）
        var tokenInfo;
        try {
            tokenInfo = await fetchImToken();
        } catch (e) {
            console.error('[chat] IM 凭证获取失败:', e);
            try { sessionStorage.removeItem('forum_chat_token'); } catch (e2) { /* 忽略 */ }
            showError('聊天服务暂不可用' + (e && e.message ? '：' + e.message : '（凭证获取失败），请稍后重试'));
            return;
        }

        // 2. 动态加载 SDK（import map 解析裸模块；CDN 失败可捕获 → 可重试错误态）
        try {
            if (!state.sdk) state.sdk = await import('@nexconn/chat');
        } catch (e) {
            showError('聊天组件加载失败，请检查网络后重试');
            return;
        }

        // 3. initialize（全生命周期仅一次；重复调用忽略）
        try {
            if (!state.engineReady) {
                state.sdk.NCEngine.initialize({ appKey: tokenInfo.appKey });
                state.engineReady = true;
            }
        } catch (e) {
            // 可能已初始化过（重试路径），视为就绪
            state.engineReady = true;
        }

        installHandlers();

        // 4. connect
        try {
            var res = await state.sdk.NCEngine.connect({ token: tokenInfo.token });
            if (!res || res.code !== 0) {
                try { sessionStorage.removeItem('forum_chat_token'); } catch (e) { /* 忽略 */ }
                showError('IM 连接失败' + (res && res.msg ? '：' + res.msg : '') + '，请重试');
                return;
            }
        } catch (e) {
            try { sessionStorage.removeItem('forum_chat_token'); } catch (e2) { /* 忽略 */ }
            showError('IM 连接异常，请稍后重试');
            return;
        }
        state.connected = true;
        setStatus('已连接');

        // 5. 主界面 + 会话列表 + 未读镜像校正（T014）
        showView('main');
        await loadConversationList();
        var total = await totalUnread();
        correctUnreadFlag(total);

        // 6. ?peer=<id> 直达会话（push 通知点击 / 各入口跳转）
        var params = new URLSearchParams(window.location.search);
        var peerParam = params.get('peer');
        if (peerParam) {
            var cleanPeer = peerParam.split('?')[0].split('#')[0].trim();
            if (cleanPeer && cleanPeer !== String(state.userId)) {
                openConversation(cleanPeer);
            }
        }
    }

    // ---- 事件绑定 ----
    function bindEvents() {
        var retryBtn = el('chat-retry-btn');
        if (retryBtn) retryBtn.addEventListener('click', function () { connectIm(); });

        var sendBtn = el('msg-send-btn');
        if (sendBtn) sendBtn.addEventListener('click', onSendClick);

        var input = el('msg-input');
        if (input) {
            input.addEventListener('keydown', function (ev) {
                if (ev.key === 'Enter') {
                    ev.preventDefault();
                    onSendClick();
                }
            });
        }

        var earlierBtn = el('load-earlier-btn');
        if (earlierBtn) earlierBtn.addEventListener('click', function () { loadHistory(false); });

        var backBtn = el('msg-back-btn');
        if (backBtn) backBtn.addEventListener('click', closeConversationView);

        // 离开页面即断开 IM 连接（释放连接数）
        window.addEventListener('pagehide', function () {
            if (state.connected && state.sdk) {
                try { state.sdk.NCEngine.disconnect(); state.connected = false; } catch (e) { /* 静默 */ }
            }
        });
    }

    // ---- 入口 ----
    async function init() {
        // 主题/背景跟随全站设置（common.js 契约：每页启动调用；storage 事件跨页实时同步）
        if (typeof window.initThemeAndBackground === 'function') window.initThemeAndBackground();
        if (typeof window.watchSettingsSync === 'function') window.watchSettingsSync();
        bindEvents();
        state.client = window.getSupabaseClient();
        if (!state.client) {
            showError('页面初始化失败，请刷新重试');
            return;
        }
        showView('gate');
        var session = await window.requireLogin(state.client, 'index.html', '请先登录后使用站内私信');
        if (!session) return; // requireLogin 已提示并跳转登录
        state.userId = session.user && session.user.id ? String(session.user.id) : '';
        if (!state.userId) {
            showError('会话异常，请重新登录');
            return;
        }
        connectIm();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
