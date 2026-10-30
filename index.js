// 海高论坛主论坛页（index.html）业务脚本：由原内联脚本逐字迁移外置，须在 config.js / common.js / main.js 之后加载（defer 顺序保证）
// 初始化主题与自定义背景（共享实现，补齐系统暗色偏好回退），并监听跨页实时同步
initThemeAndBackground();
watchSettingsSync();

// 用于暂存用户选择的图片文件
let selectedImageFile = null;

// 用户点击 “+” 按钮选择文件后的回调
window.handleImageSelect = function(input) {
    if (input.files && input.files[0]) {
        selectedImageFile = input.files[0];
        const previewEl = document.getElementById('image-preview-container');
        if (previewEl) {
            previewEl.innerHTML = `已选择图片: <span style="color: var(--primary-color);">${selectedImageFile.name}</span>`;
        }
    }
};

// 切换发表新话题 / 发布通知栏目（管理员专属）
window.togglePostMode = function() {
    if (!currentUserProfile || !currentUserProfile.is_admin) return;
    const toggleBtn = document.getElementById('post-mode-toggle');
    const isTopicMode = toggleBtn.dataset.mode === 'topic';
    const titleInput = document.getElementById('topic-title');
    const contentInput = document.getElementById('topic-content');
    const submitBtn = document.getElementById('post-submit-btn');
    const cardTitle = document.querySelector('#forum-section .card h3');

    if (isTopicMode) {
        toggleBtn.dataset.mode = 'notice';
        toggleBtn.innerText = '切换回发布话题';
        toggleBtn.style.background = '#e53e3e';
        if (cardTitle) cardTitle.innerText = '发布系统通知';
        titleInput.placeholder = '通知标题...';
        contentInput.placeholder = '输入要发送给所有用户的通知内容...';
        submitBtn.innerText = '确认发送通知';
        submitBtn.style.background = '#e53e3e';
    } else {
        toggleBtn.dataset.mode = 'topic';
        toggleBtn.innerText = '切换全局通知';
        toggleBtn.style.background = '#718096';
        if (cardTitle) cardTitle.innerText = '发表新话题';
        titleInput.placeholder = '话题标题...';
        contentInput.placeholder = '分享你的新鲜事、求助或闲置信息...';
        submitBtn.innerText = '发布话题';
        submitBtn.style.background = '';
    }
};

window.handlePostSubmit = async function() {
    const isTopicMode = document.getElementById('post-mode-toggle').dataset.mode === 'topic';
    if (isTopicMode) {
        window.createTopic();
    } else {
        if (!currentUserProfile || !currentUserProfile.is_admin) {
            alert('权限不足！');
            return;
        }
        const title = document.getElementById('topic-title').value.trim();
        const content = document.getElementById('topic-content').value.trim();
        if (!title || !content) {
            alert('通知标题和内容不能为空！');
            return;
        }
        if (!confirm('确定要向全体注册用户发送该系统通知吗？')) return;

        const { data: profiles, error: profileErr } = await db.from('profiles').select('id');
        if (profileErr || !profiles || profiles.length === 0) {
            alert('获取用户列表失败: ' + (profileErr ? profileErr.message : '无用户'));
            return;
        }

        const senderName = currentUserProfile.nickname || '管理员';
        const notificationsData = profiles.map(user => ({
            user_id: user.id,
            title: `[系统通知] ${title}`,
            content: `${content} (发送者: ${senderName})`,
            is_read: false
        }));

        const { error: insertErr } = await db.from('notifications').insert(notificationsData);
        if (insertErr) {
            alert('发布通知失败: ' + insertErr.message);
        } else {
            alert(`成功向 ${profiles.length} 名用户发布了系统通知！`);
            document.getElementById('topic-title').value = '';
            document.getElementById('topic-content').value = '';
            window.togglePostMode();
        }
    }
};

// 全局唯一 Supabase 客户端（由 common.js 的 getSupabaseClient() 懒创建并挂载 window.sbApp）
const db = getSupabaseClient();

let currentCategoryId = null;
let currentUserProfile = null;
let currentAuthUser = null;
// 当前页话题内存映射：openEditModal 仅凭 topicId 回查标题/内容，避免把用户内容内联进 onclick
let currentTopicsMap = {};
// 当前页相关用户档案映射：replyToUser 仅凭评论者 user_id 回查昵称
let currentProfileMap = {};
// 板块 DOM/名称映射：供话题深链激活板块样式、搜索结果展示板块名
let categoryDomMap = {};
let categoryNameMap = {};
// 板块加载完成信号：供冷启动话题深链等待默认话题流就绪，避免并发渲染相互覆盖
let categoriesLoadedResolve = null;
const categoriesLoadedPromise = new Promise(resolve => { categoriesLoadedResolve = resolve; });
let initialTopicsLoadPromise = null;

db.auth.getSession().then(({ data: { session } }) => {
    if (session) initUserSession(session.user);
});
// 定义一个全局同步函数，供 main.js 或登录成功后调用
window.trySyncPushSubscription = async function() {
    if (!window.globalPushSubscription || !currentAuthUser) return;

    try {
        const { error: dbError } = await db.from('push_subscriptions').upsert({
            user_id: currentAuthUser.id,
            subscription: window.globalPushSubscription
        }, { onConflict: 'user_id' });

        if (dbError) {
            console.error('写入 push_subscriptions 数据库失败:', dbError.message);
        } else {
            console.log('🎉 推送订阅凭证已成功同步至 Supabase 数据库！');
        }
    } catch (e) {
        console.error('同步推送订阅异常:', e);
    }
};

async function initUserSession(user) {
    currentAuthUser = user; 

    // 临时档案先行：资料返回前，所有档案依赖方（openProfile / 发帖 / 评论等）拿到合法兜底值（is_admin: false = 管理入口安全默认隐藏）
    currentUserProfile = { nickname: user.email.split('@')[0], is_admin: false, email: user.email };

    // 1. 尝试同步推送订阅到数据库（此时 db 和 user 均已 100% 就绪）
    if (typeof window.trySyncPushSubscription === 'function') {
        window.trySyncPushSubscription();
    }
    
    // === 将当前登录用户的 ID 同步给 Service Worker 用于后台通知 ===
    if (window.syncUserIdToSW) {
        window.syncUserIdToSW(user.id);
    }

    // === 内容快照恢复（US2，plan R&D-D3/D4；深链优先：URL 含 topic 参数则跳过快照，由 consumeUrlParams 深链流程接管）===
    // 恢复成功：showForum 跳过默认无参 loadCategories（三路径互斥、无双调用），快照 DOM 同步呈现，
    // 随后 loadCategories(快照板块, 快照页) 后台静默校正（不 await 不阻塞，校正渲染自然写入新快照=快照自愈）；
    // 恢复失败/无快照/深链存在：现状路径完全不变（showForum 内无参 loadCategories 照旧）
    const hasTopicDeepLink = new URLSearchParams(window.location.search).has('topic');
    const restoredSnapshot = hasTopicDeepLink ? null : restoreSnapshot(user.id);

    // 论坛先显示：不再被 profiles 查询的网络往返阻塞，分类/列表加载（loadCategories）立即启动
    showForum(restoredSnapshot ? true : undefined);

    if (restoredSnapshot) {
        // 同步写入快照渲染产物（innerHTML 均为历史渲染结果，FR-009 渲染一致性天然满足）
        document.getElementById('categories-list').innerHTML = restoredSnapshot.categoriesHtml;
        document.getElementById('topics-container').innerHTML = restoredSnapshot.topicsHtml;
        // 恢复全局浏览状态（编辑弹窗 topicsMap / 回复回查 profileMap 一并恢复，恢复后即可用）
        currentCategoryId = restoredSnapshot.categoryId;
        currentPage = restoredSnapshot.page || 1;
        totalTopicsCount = restoredSnapshot.totalTopicsCount || 0;
        currentTopicsMap = restoredSnapshot.topicsMap || {};
        currentProfileMap = restoredSnapshot.profileMap || {};
        updatePaginationUI();
        scrollTo(0, restoredSnapshot.scrollY || 0);
        // 后台校正：板块列表刷新 + 快照板块快照页话题流静默覆盖快照（不 await 不阻塞）
        loadCategories(restoredSnapshot.categoryId, restoredSnapshot.page);
    }

    // 未读红点检查与在线状态上报均为 fire-and-forget，提前执行
    checkUnreadNotifications(user.id);
    if (typeof window.initGlobalPresence === 'function') {
        window.initGlobalPresence(user);
    }

    // 唯一阻塞点：拉取真实档案。成功则以真实资料覆盖临时档案（email 为空则回填，保持原语义）；失败（data null / 网络异常）保留临时档案兜底
    let profileData = null;
    try {
        const { data } = await db.from('profiles').select('*').eq('id', user.id).single();
        profileData = data;
    } catch (e) {
        // 网络异常等极端情况：静默保留临时档案，论坛照常可用
    }
    if (profileData) {
        currentUserProfile = profileData;
        if (!currentUserProfile.email) currentUserProfile.email = user.email;
    }

    // 登出竞态守卫：查询期间已登出/切换账号（currentAuthUser 已不是该 user）则放弃填充，避免向已登出界面写入档案内容
    if (!currentAuthUser || currentAuthUser.id !== user.id) return;

    document.getElementById('user-profile-summary').innerHTML = `欢迎回来，<b>${escapeHtml(currentUserProfile.nickname)}</b> <span class="badge-admin">${currentUserProfile.is_admin ? '管理员' : '成员'}</span>`;
    
    const toggleBtn = document.getElementById('post-mode-toggle');
    if (toggleBtn) {
        if (currentUserProfile && currentUserProfile.is_admin) {
            toggleBtn.classList.remove('hidden');
        } else {
            toggleBtn.classList.add('hidden');
        }
    }

    document.querySelectorAll('.admin-only').forEach(el => {
        if (currentUserProfile && currentUserProfile.is_admin) {
            el.classList.remove('hidden');
        } else {
            el.classList.add('hidden');
        }
    });

    // 消费 URL 参数（topic/comment 话题深链 + edit=1 自动打开个人中心编辑面板）：
    // 置于档案填充完成之后，保证 openProfile/深链拿到真实资料，冷启动"先显示后填充"时序不被破坏
    consumeUrlParams();

    // 站内私信未读徽标（US3）：异步注入 chat-badge.js（加载失败静默，不阻塞首页关键路径，plan D2/SC-003）
    initChatBadge();
}

// 站内私信：跳转聊天页并定位与目标用户的会话（各"发消息"入口统一走此函数，US2）
window.startChatWith = function(userId) {
    if (!userId) return;
    window.location.href = 'chat.html?peer=' + encodeURIComponent(userId);
};

// 站内私信徽标注入器（T013）：幂等——已加载直接 init、加载中跳过（onload 回调收口）、未加载异步注入
function initChatBadge() {
    try {
        if (window.LTChatBadge) {
            window.LTChatBadge.init(window.sbApp, currentAuthUser && currentAuthUser.id);
            return;
        }
        if (document.querySelector('script[data-lt-chat-badge="1"]')) return; // 正在加载，onload 回调会完成 init
        const s = document.createElement('script');
        s.src = 'chat-badge.js?v=1';
        s.async = true;
        s.setAttribute('data-lt-chat-badge', '1');
        s.onload = () => {
            if (window.LTChatBadge && window.sbApp && currentAuthUser) {
                window.LTChatBadge.init(window.sbApp, currentAuthUser.id);
            }
        };
        s.onerror = () => { /* 徽标加载失败静默（增强功能，不阻断论坛主流程） */ };
        document.head.appendChild(s);
    } catch (e) { /* 静默 */ }
}

async function checkUnreadNotifications(userId) {
    // 使用 head count 计数查询判断未读红点，避免拉取全部通知行
    const { count } = await db.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('is_read', false);
    if (count && count > 0) {
        document.getElementById('notification-badge').classList.remove('hidden');
    } else {
        document.getElementById('notification-badge').classList.add('hidden');
    }
}

// skipCategoryLoad（可选，仅快照恢复成功路径传 true）：跳过末尾默认无参 loadCategories，
// 由快照恢复路径接管渲染（三路径互斥、无双调用）；既有无参调用点（closeProfile 返回论坛）行为不变
function showForum(skipCategoryLoad) {
    document.getElementById('auth-section').classList.add('hidden');
    document.getElementById('profile-section').classList.add('hidden');
    document.getElementById('forum-section').classList.remove('hidden');
    if (skipCategoryLoad !== true) {
        loadCategories();
    }
}

window.openProfile = async function() {
    if (!currentAuthUser) return;
    document.getElementById('profile-email').value = currentAuthUser.email;
    document.getElementById('profile-role').value = currentUserProfile.is_admin ? '🛡️ 管理员 (Admin)' : '普通成员';
    document.getElementById('p-grade').value = currentUserProfile.grade || '英才';
    document.getElementById('p-nickname').value = currentUserProfile.nickname || '';
    document.getElementById('p-real-name').value = currentUserProfile.real_name || '';
    document.getElementById('p-phone').value = currentUserProfile.phone || '';
    document.getElementById('p-gender').value = currentUserProfile.gender || '';
    document.getElementById('p-age').value = currentUserProfile.age || '';
    document.getElementById('p-birthday').value = currentUserProfile.birthday || '';
    document.getElementById('p-constellation').value = currentUserProfile.constellation || '';
    document.getElementById('p-hometown').value = currentUserProfile.hometown || '';
    
    document.getElementById('pub-email').checked = !!currentUserProfile.public_email;
    document.getElementById('pub-real-name').checked = !!currentUserProfile.public_real_name;
    document.getElementById('pub-phone').checked = !!currentUserProfile.public_phone;
    document.getElementById('pub-gender').checked = currentUserProfile.public_gender !== false;
    document.getElementById('pub-age').checked = currentUserProfile.public_age !== false;
    document.getElementById('pub-birthday').checked = currentUserProfile.public_birthday !== false;
    document.getElementById('pub-constellation').checked = currentUserProfile.public_constellation !== false;
    document.getElementById('pub-hometown').checked = currentUserProfile.public_hometown !== false;

    loadNotifications(currentAuthUser.id);
    document.getElementById('forum-section').classList.add('hidden');
    document.getElementById('profile-section').classList.remove('hidden');
}

async function loadNotifications(userId) {
    const container = document.getElementById('notifications-list');
    const { data } = await db.from('notifications').select('*').eq('user_id', userId).order('created_at', { ascending: false });
    if (!data || data.length === 0) {
        container.innerHTML = '<p style="font-size:13px; color:var(--meta-color);">暂无任何系统通知</p>';
        return;
    }
    container.innerHTML = '';
    data.forEach(notif => {
        const div = document.createElement('div');
        div.className = 'card';
        div.style.cssText = `padding: 10px; margin-bottom: 8px; font-size: 13px; ${notif.is_read ? '' : 'border-left: 3px solid var(--primary-color);'}`;
        // 解析提及通知尾部的跳转定位标记 [[t:<topicId>,c:<commentId>]]
        // （与 createComment 提及通知组装格式严格互逆）：剥离后展示干净文本，含标记卡片可点击跳转
        const markerMatch = typeof notif.content === 'string'
            ? notif.content.match(/\[\[t:([^,\]]+),c:([^\]]+)\]\]\s*$/)
            : null;
        let displayContent = notif.content;
        if (markerMatch) {
            displayContent = notif.content.slice(0, markerMatch.index).trim();
            const deepTopicId = markerMatch[1];
            const deepCommentId = markerMatch[2];
            div.style.cursor = 'pointer';
            div.title = '点击跳转到相关话题';
            div.onclick = () => {
                window.location.href = 'index.html?topic=' + encodeURIComponent(deepTopicId) + '&comment=' + encodeURIComponent(deepCommentId);
            };
        }
        div.innerHTML = `
            <div class="flex" style="margin-bottom:4px;">
                <b>${escapeHtml(notif.title)}</b>
                <span style="font-size:11px; color:var(--meta-color);">${new Date(notif.created_at).toLocaleString()}</span>
            </div>
            <p style="margin:0;">${escapeHtml(displayContent)}${markerMatch ? ' <span style="color:var(--primary-color); font-size:11px;">↗ 点击跳转</span>' : ''}</p>
        `;
        container.appendChild(div);
    });
    await db.from('notifications').update({ is_read: true }).eq('user_id', userId).eq('is_read', false);
    document.getElementById('notification-badge').classList.add('hidden');
}

window.closeProfile = function() {
    showForum();
}

window.saveCustomBackground = function() {
    const fileInput = document.getElementById('bg-file-input');
    if (!fileInput.files || !fileInput.files[0]) {
        alert('请先选择一张图片文件！');
        return;
    }
    const file = fileInput.files[0];
    const reader = new FileReader();
    reader.onload = function(e) {
        const img = new Image();
        img.src = e.target.result;
        img.onload = function() {
            let width = img.width;
            let height = img.height;
            const maxWidth = 1920;
            const maxHeight = 1080;
            if (width > maxWidth || height > maxHeight) {
                if (width / height > maxWidth / maxHeight) {
                    height = Math.round((height * maxWidth) / width);
                    width = maxWidth;
                } else {
                    width = Math.round((width * maxHeight) / height);
                    height = maxHeight;
                }
            }
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.85);
            localStorage.setItem('forum_custom_bg', compressedDataUrl);
            document.body.style.backgroundImage = `url("${compressedDataUrl}")`;
            alert('自定义背景已保存！');
        };
        img.onerror = function() {
            alert('图片加载失败，请换一张图片尝试！');
        };
    };
    reader.readAsDataURL(file);
};

window.resetCustomBackground = function() {
    localStorage.removeItem('forum_custom_bg');
    document.body.style.backgroundImage = '';
    document.getElementById('bg-file-input').value = '';
    alert('已成功恢复默认背景');
};

window.updatePassword = async function() {
    const newPassword = document.getElementById('new-password').value;
    const msgEl = document.getElementById('password-msg');
    if (!newPassword || newPassword.length < 6) {
        msgEl.style.color = 'red';
        msgEl.innerText = '新密码长度不能少于 6 位字符！';
        return;
    }
    const { error } = await db.auth.updateUser({ password: newPassword });
    if (error) {
        msgEl.style.color = 'red';
        msgEl.innerText = '密码修改失败: ' + error.message;
    } else {
        msgEl.style.color = 'green';
        msgEl.innerText = '密码修改成功！下次登录请使用新密码。';
        document.getElementById('new-password').value = '';
    }
};

window.updateProfile = async function() {
    const nickname = document.getElementById('p-nickname').value.trim();
    const msgEl = document.getElementById('profile-msg');
    if (!nickname) return alert('昵称不能为空！');
    const grade = document.getElementById('p-grade').value;
    if (!grade) {
        alert('请选择年级！');
        return;
    }
    const updateData = {
        nickname,
        grade,
        real_name: document.getElementById('p-real-name').value.trim(),
        phone: document.getElementById('p-phone').value.trim(),
        gender: document.getElementById('p-gender').value.trim(),
        age: document.getElementById('p-age').value ? parseInt(document.getElementById('p-age').value) : null,
        birthday: document.getElementById('p-birthday').value.trim(),
        constellation: document.getElementById('p-constellation').value.trim(),
        hometown: document.getElementById('p-hometown').value.trim(),
        public_email: document.getElementById('pub-email').checked,
        public_real_name: document.getElementById('pub-real-name').checked,
        public_phone: document.getElementById('pub-phone').checked,
        public_gender: document.getElementById('pub-gender').checked,
        public_age: document.getElementById('pub-age').checked,
        public_birthday: document.getElementById('pub-birthday').checked,
        public_constellation: document.getElementById('pub-constellation').checked,
        public_hometown: document.getElementById('pub-hometown').checked
    };

    const { error } = await db.from('profiles').update(updateData).eq('id', currentAuthUser.id);
    if (error) {
        msgEl.style.color = 'red';
        msgEl.innerText = '更新失败: ' + error.message;
    } else {
        currentUserProfile = { ...currentUserProfile, ...updateData };
        msgEl.style.color = 'green';
        msgEl.innerText = '资料更新成功！';
        document.getElementById('user-profile-summary').innerHTML = `欢迎回来，<b>${escapeHtml(currentUserProfile.nickname)}</b> <span class="badge-admin">${currentUserProfile.is_admin ? '管理员' : '成员'}</span>`;
    }
};

window.handleLogin = async function() {
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const msgEl = document.getElementById('auth-msg');
    if (!email || !password) {
        msgEl.innerText = '请输入邮箱和密码';
        return;
    }
    const { data, error } = await db.auth.signInWithPassword({ email, password });
    if (error) {
        msgEl.innerText = '登录失败: ' + error.message;
    } else {
        msgEl.innerText = '';
        initUserSession(data.user);
    }
};

window.handleRegister = async function() {
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value.trim();
    const authMsg = document.getElementById('auth-msg');
    
    // 1. 定义校验规则：仅允许 QQ 邮箱 或 Gmail 邮箱，且严格排除包含 "+" 的别名邮箱
    const qqEmailRegex = /^[1-9]\d{4,10}@qq\.com$/i;
    const gmailRegex = /^[a-zA-Z0-9._]+@gmail\.com$/i;

    // 2. 检查是否包含 "+" 符号（防止通过别名绕过）
    if (email.includes('+')) {
        authMsg.innerText = '注册失败：不支持使用包含 "+" 的别名邮箱。';
        return;
    }

    // 3. 验证是否为合法的 QQ 邮箱或 Gmail 邮箱
    if (!qqEmailRegex.test(email) && !gmailRegex.test(email)) {
        authMsg.innerText = '注册失败：仅限使用标准的 QQ 邮箱或 Gmail 邮箱注册！';
        return;
    }

    // 4. 前端校验密码长度（不少于 6 位，与登录提示保持一致），校验失败不发请求
    if (!password || password.length < 6) {
        authMsg.innerText = '注册失败：密码长度不能少于 6 位字符！';
        return;
    }

    // 清空错误提示，继续执行原有的 Supabase 注册逻辑
    authMsg.innerText = '';
    
    const { data, error } = await db.auth.signUp({ email, password });
    if (error) {
        authMsg.innerText = '注册出错: ' + error.message;
    } else {
        alert('注册成功，请查收验证邮件！');
    }
};

window.handleLogout = async function() {
    // 隐私红线（FR-004）：登出动作触发即清空内容快照与滚动位置两 key，
    // 下一个使用者不可见上一个用户浏览内容（清空失败静默，不阻断登出）
    clearSnapshot();
    // 站内私信徽标清理（T013）：断开 Realtime 订阅并隐藏徽标（置于 signOut 前，确保用户上下文仍在）
    if (window.LTChatBadge) {
        try { window.LTChatBadge.cleanup(); } catch (e) { /* 徽标清理失败静默 */ }
    }
    await db.auth.signOut();
    currentUserProfile = null;
    currentAuthUser = null;
    currentTopicsMap = {};
    currentProfileMap = {};
    document.getElementById('forum-section').classList.add('hidden');
    document.getElementById('profile-section').classList.add('hidden');
    document.getElementById('auth-section').classList.remove('hidden');
    document.getElementById('email').value = '';
    document.getElementById('password').value = '';
    document.getElementById('auth-msg').innerText = '';
    // 复位列表容器为初始“加载中”状态
    document.getElementById('topics-container').innerHTML = '<p style="font-size:13px; color:var(--meta-color);">加载中...</p>';
    document.getElementById('categories-list').innerText = '加载中...';
};

window.toggleTheme = function() {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    if (currentTheme === 'dark') {
        document.documentElement.removeAttribute('data-theme');
        localStorage.setItem('forum_theme', 'light');
    } else {
        document.documentElement.setAttribute('data-theme', 'dark');
        localStorage.setItem('forum_theme', 'dark');
    }
};

// ==================== 内容快照模块（US2，plan R&D-D3） ====================
// 已登录用户论坛浏览态快照：localStorage 双 key——主体（渲染产物+分页+映射表）与滚动位置分离，
// 滚动高频写不触发整块快照重写；登出清理、换号不恢复、损坏即弃（FR-004/FR-005 隐私与回落红线）
const SNAPSHOT_KEYS = {
    main: 'forum_content_snapshot_v1',
    scroll: 'forum_snapshot_scroll_v1'
};
const SNAPSHOT_STRUCT_VER = 1;

// 写主体快照：structVer 内嵌（渲染结构变更时 bump，恢复校验不符即弃）；配额/禁用异常静默
function saveSnapshot(userId, categoryId, page, totalTopicsCount, categoriesHtml, topicsHtml, topicsMap, profileMap) {
    try {
        localStorage.setItem(SNAPSHOT_KEYS.main, JSON.stringify({
            userId: userId,
            structVer: SNAPSHOT_STRUCT_VER,
            categoryId: categoryId,
            page: page,
            totalTopicsCount: totalTopicsCount,
            categoriesHtml: categoriesHtml,
            topicsHtml: topicsHtml,
            topicsMap: topicsMap,
            profileMap: profileMap,
            savedAt: Date.now()
        }));
    } catch (e) {
        // 超配额 / 隐私模式禁用等：写入失败静默（回落正常加载，不报错不阻塞）
    }
}

// 写滚动位置（独立小 key 支撑高频写）
function saveScroll(userId, scrollY) {
    try {
        localStorage.setItem(SNAPSHOT_KEYS.scroll, JSON.stringify({
            userId: userId,
            scrollY: scrollY
        }));
    } catch (e) {
        // 同上：静默
    }
}

// 清空两 key（登出隐私红线 + 换号/损坏清理共用）
function clearSnapshot() {
    try {
        localStorage.removeItem(SNAPSHOT_KEYS.main);
        localStorage.removeItem(SNAPSHOT_KEYS.scroll);
    } catch (e) {
        // 静默
    }
}

// 恢复快照：读两 key → 解析 → 校验（归属用户匹配 + 结构版本 + 渲染产物非空）→ 合并返回（含 scrollY）；
// 任一步失败返回 null 且不抛错；userId 不匹配（换号残留）时清掉两 key，防串号
function restoreSnapshot(userId) {
    let mainRaw = null;
    let scrollRaw = null;
    try {
        mainRaw = localStorage.getItem(SNAPSHOT_KEYS.main);
        scrollRaw = localStorage.getItem(SNAPSHOT_KEYS.scroll);
    } catch (e) {
        return null;
    }
    if (!mainRaw) return null;

    let snapshot = null;
    try {
        snapshot = JSON.parse(mainRaw);
    } catch (e) {
        // 主体损坏即弃（清残留，回落正常加载）
        clearSnapshot();
        return null;
    }
    // 归属用户不符：清两 key（防换号残留），走正常加载
    if (!snapshot || snapshot.userId !== userId) {
        clearSnapshot();
        return null;
    }
    // 结构校验：版本不符或渲染产物缺失即弃（未来渲染结构变更时 bump structVer 即在此拦截）
    if (snapshot.structVer !== SNAPSHOT_STRUCT_VER ||
        typeof snapshot.categoriesHtml !== 'string' || snapshot.categoriesHtml === '' ||
        typeof snapshot.topicsHtml !== 'string' || snapshot.topicsHtml === '') {
        clearSnapshot();
        return null;
    }

    // 滚动位置合并（滚动 key 损坏/缺失/归属不符则回退 0，不阻断主体恢复）
    let scrollY = 0;
    if (scrollRaw) {
        try {
            const scrollData = JSON.parse(scrollRaw);
            if (scrollData && scrollData.userId === userId && typeof scrollData.scrollY === 'number') {
                scrollY = scrollData.scrollY;
            }
        } catch (e) {
            // 滚动数据损坏：忽略，保持 0
        }
    }
    snapshot.scrollY = scrollY;
    return snapshot;
}

// 主体快照 categoriesHtml 字段合并更新：读现有主体快照→仅更新该字段→写回
// （不覆盖 topicsHtml 等其余字段；快照不存在则跳过，主体由 loadTopics 渲染完成时全量写入）
function updateSnapshotCategoriesHtml() {
    try {
        const raw = localStorage.getItem(SNAPSHOT_KEYS.main);
        if (!raw) return;
        const listEl = document.getElementById('categories-list');
        const html = listEl ? listEl.innerHTML : '';
        if (!html) return;
        const snapshot = JSON.parse(raw);
        if (!snapshot) return;
        snapshot.categoriesHtml = html;
        localStorage.setItem(SNAPSHOT_KEYS.main, JSON.stringify(snapshot));
    } catch (e) {
        // localStorage 禁用 / 快照损坏：静默跳过（快照自愈交给下次 loadTopics 全量写入）
    }
}

// 当前浏览态写主体快照（loadTopics 渲染完成尾部调用）：categoriesHtml 取当前 DOM，与渲染结果天然一致；
// 映射表/分页状态取全局内存值；写入在渲染完成之后，不阻塞渲染（FR-009：快照即渲染结果本身）
function saveCurrentContentSnapshot(categoryId) {
    if (!currentAuthUser) return;
    const categoriesEl = document.getElementById('categories-list');
    const topicsEl = document.getElementById('topics-container');
    saveSnapshot(
        currentAuthUser.id,
        categoryId,
        currentPage,
        totalTopicsCount,
        categoriesEl ? categoriesEl.innerHTML : '',
        topicsEl ? topicsEl.innerHTML : '',
        currentTopicsMap,
        currentProfileMap
    );
}

// 滚动位置持久化监听（仅注册一次）：scroll 500ms 防抖 + visibilitychange(hidden) 即时写
// （PWA 被系统直接杀死前的最后写入时机）；用当前已登录用户 id
let snapshotScrollTimer = null;
window.addEventListener('scroll', () => {
    if (snapshotScrollTimer) clearTimeout(snapshotScrollTimer);
    snapshotScrollTimer = setTimeout(() => {
        snapshotScrollTimer = null;
        if (currentAuthUser) saveScroll(currentAuthUser.id, window.scrollY);
    }, 500);
});
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && currentAuthUser) {
        saveScroll(currentAuthUser.id, window.scrollY);
    }
});

// preselectCategoryId/preselectPage（可选，快照恢复后台校正场景传入）：板块列表 active 态与
// 末尾自动加载落在该板块/该页；无参调用时缺省=首板块第 1 页，与既有默认行为逐行等价（现有无参调用点零改动）
async function loadCategories(preselectCategoryId, preselectPage) {
    const container = document.getElementById('categories-list');
    const { data, error } = await db.from('categories').select('*').order('id', { ascending: true });
    if (error || !data || data.length === 0) {
        container.innerHTML = '<p style="font-size:12px; color:var(--meta-color);">暂无板块</p>';
        // 板块加载结束（含失败路径）：释放深链等待信号
        categoriesLoadedResolve();
        return;
    }
    // 预选板块解析：传入 id 无效（已删除/不存在）时回落首板块，与快照"损坏即弃"口径一致
    const hasValidPreselect = preselectCategoryId != null && data.some(cat => cat.id === preselectCategoryId);
    const targetCategoryId = hasValidPreselect ? preselectCategoryId : data[0].id;
    container.innerHTML = '';
    categoryDomMap = {};
    categoryNameMap = {};
    data.forEach(cat => {
        const div = document.createElement('div');
        div.className = 'category-item' + (cat.id === targetCategoryId ? ' active' : '');
        div.innerText = cat.name;
        // 记录板块 DOM 与名称映射（供深链激活板块样式 / 搜索结果展示板块名）
        categoryDomMap[cat.id] = div;
        categoryNameMap[cat.id] = cat.name;
        div.onclick = () => {
            document.querySelectorAll('.category-item').forEach(el => el.classList.remove('active'));
            div.classList.add('active');
            currentCategoryId = cat.id;
            // 点击板块即进入浏览态：清空搜索框，保持"输入框内容驱动"的状态一致性
            const searchEl = document.getElementById('search-input');
            if (searchEl && searchEl.value) searchEl.value = '';
            loadTopics(cat.id);
        };
        container.appendChild(div);
    });
    if (data.length > 0) {
        currentCategoryId = targetCategoryId;
        // 记录默认板块话题流 Promise，供冷启动话题深链等待其就绪后再接管
        initialTopicsLoadPromise = loadTopics(targetCategoryId, preselectPage);
    }
    // 板块加载结束：释放深链等待信号
    categoriesLoadedResolve();
    // 渲染完成：更新主体快照 categoriesHtml 字段（读改写合并；快照不存在则跳过）
    updateSnapshotCategoriesHtml();
}

let currentPage = 1;
const pageSize = 5;
let totalTopicsCount = 0;

// 加载指定板块的话题（支持页码）
async function loadTopics(categoryId, page = 1) {
    currentCategoryId = categoryId;
    currentPage = page;
    
    const container = document.getElementById('topics-container');
    container.innerHTML = '<p style="font-size:13px; color:var(--meta-color);">加载中...</p>';

    // 查询总数与当前页数据
    const from = (currentPage - 1) * pageSize;
    const to = from + pageSize - 1;

    const { data: topics, error, count } = await db
        .from('topics')
        .select('*', { count: 'exact' })// 获取总记录数用于计算总页数
        .eq('category_id', categoryId)
        .order('created_at', { ascending: false })
        .range(from, to);// 核心：限制单次加载数量并分页

    if (count !== null) totalTopicsCount = count;

    if (error || !topics || topics.length === 0) {
        currentTopicsMap = {};
        currentProfileMap = {};
        container.innerHTML = '<div class="card"><p style="font-size:13px; color:var(--meta-color); margin:0;">该板块下暂无话题，快来发表第一个话题吧！</p></div>';
        updatePaginationUI();
        // 查询成功但板块为空亦属有效浏览态：同样写主体快照；查询失败（error）则跳过，
        // 避免瞬时网络故障用"暂无话题"覆盖好的历史快照
        if (!error) {
            saveCurrentContentSnapshot(categoryId);
        }
        return;
    }

    const topicIds = topics.map(t =>t.id);

    const { data: comments } = await db.from('comments').select('*').in('topic_id', topicIds);
    const commentMap = {};

    if (comments) {
        comments.forEach(c => {
            if (!commentMap[c.topic_id]) commentMap[c.topic_id] = []; 
            commentMap[c.topic_id].push(c);
        });
    }

    // 仅按需查询当前页话题与评论涉及的用户档案（避免为渲染昵称全量拉取 profiles）
    const userIdSet = new Set();
    topics.forEach(t => userIdSet.add(t.user_id));
    if (comments) {
        comments.forEach(c => userIdSet.add(c.user_id));
    }
    const profileMap = {};
    const userIds = Array.from(userIdSet);
    if (userIds.length > 0) {
        const { data: profilesData } = await db.from('profiles').select('id, nickname, is_admin').in('id', userIds);
        if (profilesData) {
            profilesData.forEach(p => { 
                profileMap[p.id] = p; 
            });
        }
    }
    currentProfileMap = profileMap;

    // 维护当前页话题内存映射（供编辑弹窗按 ID 回查标题/内容）
    currentTopicsMap = {};
    topics.forEach(t => { currentTopicsMap[t.id] = t; });

    let likedSet = new Set();
    let favSet = new Set();
    if (currentAuthUser) {
        const { data: userLikes } = await db.from('likes').select('topic_id').eq('user_id', currentAuthUser.id).in('topic_id', topicIds);
        if (userLikes) userLikes.forEach(l => likedSet.add(l.topic_id));
        
        const { data: userFavs } = await db.from('favorites').select('topic_id').eq('user_id', currentAuthUser.id).in('topic_id', topicIds);
        if (userFavs) userFavs.forEach(f => favSet.add(f.topic_id));
    }
    
    const { data: allLikes } = await db.from('likes').select('topic_id').in('topic_id', topicIds);
    const likeCountMap = {};
    if (allLikes) {
        allLikes.forEach(l => {
            likeCountMap[l.topic_id] = (likeCountMap[l.topic_id] || 0) + 1;
        });
    }

    // 清空容器并循环渲染当前页的帖子
    container.innerHTML = ''; 
    
    for (const topic of topics) {
        const div = document.createElement('div');
        div.className = 'card';
        // 话题卡片 DOM 锚点（话题深链滚动定位目标，纯属性添加）
        div.id = 'topic-' + topic.id;

        // 图片渲染：统一使用共享修复后的历史图片地址（旧域名替换 / undefined 路径修复）
        const fixedImageUrl = fixImageUrl(topic.image_url);
        let imageHtml = '';
        if (topic.image_url && topic.image_url.trim() !== '') {
            imageHtml = `<div style="margin-top: 8px; margin-bottom: 8px;">
                            <img src="${fixedImageUrl}" alt="帖子图片" style="max-width: 100%; max-height: 400px; border-radius: 6px; display: block; object-fit: contain;">
                         </div>`;
        }

        const authorProfile = profileMap[topic.user_id];
        const authorName = authorProfile ? authorProfile.nickname : (topic.user_name || '匿名用户');
        const isAdmin = authorProfile && authorProfile.is_admin;
        const badge = isAdmin ? '<span class="badge-admin">管理员</span>' : '';

        // 1. 获取当前帖子的评论列表并生成 commentsHtml
        const topicComments = commentMap[topic.id] || [];
        let commentsHtml = '';
        topicComments.forEach(comment => {
            const commentAuthor = profileMap[comment.user_id] ? profileMap[comment.user_id].nickname : '匿名用户';
            const isCommentOwner = currentAuthUser && currentAuthUser.id === comment.user_id;
            const isCommentAdmin = currentUserProfile && currentUserProfile.is_admin;
            const canDeleteComment = isCommentOwner || isCommentAdmin;
            // --- 处理评论时间 ---
            let timeString = '';
            if (comment.created_at) {
                const date = new Date(comment.created_at);
                const year = date.getFullYear();
                const month = String(date.getMonth() + 1).padStart(2, '0');
                const day = String(date.getDate()).padStart(2, '0');
                const hours = String(date.getHours()).padStart(2, '0');
                const minutes = String(date.getMinutes()).padStart(2, '0');
                const seconds = String(date.getSeconds()).padStart(2, '0');
                timeString = `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`;
            }
            const timeHtml = timeString ? `<span style="color:#718096; font-size:10px; margin-left:6px;">${timeString}</span>` : '';
            // 回复仅传话题 ID 与评论者用户 ID，昵称由处理函数从内存映射回查
            let replyAction = `<button onclick="window.replyToUser('${topic.id}', '${comment.user_id}')" style="background:transparent; color:var(--primary-color, #3182ce); border:none; font-weight: normal; font-size:9px; cursor:pointer; padding:0 4px; margin-left:6px;">回复</button>`;
            // 站内私信入口（US2）：评论作者旁"发消息"小按钮，自己对自己不出现
            const commentChatBtn = (currentAuthUser && currentAuthUser.id !== comment.user_id)
                ? `<button onclick="window.startChatWith('${comment.user_id}')" style="background:transparent; color:#3182ce; border:none; font-weight:normal; font-size:9px; cursor:pointer; padding:0 4px; margin-left:2px;">发消息</button>`
                : '';

            let commentActions = '';
            if (canDeleteComment) {
                commentActions += `<button onclick="window.deleteComment('${comment.id}')" style="background:transparent; color:#e53e3e; border:none; font-size:11px; cursor:pointer; padding:0 4px;">删除</button>`;
            }
            commentsHtml += `
                <div id="comment-${comment.id}" style="font-size:12px; margin-top:3px; padding-bottom:2px; display:flex; justify-content:space-between; align-items:center;">
                    <div>
                        <span class="clickable-name" onclick="window.viewUserProfile('${comment.user_id}')">${escapeHtml(commentAuthor)}</span><b>:</b> ${escapeHtml(comment.content)} ${timeHtml} ${replyAction}${commentChatBtn}
                    </div>
                    <div style="flex-shrink:0;">
                        ${commentActions}
                    </div>
                </div>
            `;
        });
        
        // 权限判断
        const isOwner = currentAuthUser && currentAuthUser.id === topic.user_id;
        const isUserAdmin = currentUserProfile && currentUserProfile.is_admin;

        const isLiked = likedSet.has(topic.id);        
        const isFavorited = favSet.has(topic.id);        
        const likeCount = likeCountMap[topic.id] || 0;
        // 站内私信入口（US2）：帖子作者旁"发消息"小按钮，自己对自己不出现
        const topicChatBtn = (currentAuthUser && currentAuthUser.id !== topic.user_id)
            ? `<button onclick="window.startChatWith('${topic.user_id}')" style="background:transparent; color:#3182ce; border:none; font-weight:normal; font-size:10px; cursor:pointer; padding:0 2px; margin-left:4px;">发消息</button>`
            : '';
        // 权限与操作按钮定义（编辑仅传话题 ID，内容从内存映射回查）
        let ownerActions = '';
        if (isOwner) {
            ownerActions += `<button onclick="window.openEditModal('${topic.id}')" style="background:transparent; color:#d69e2e; border:none; font-size:11px; cursor:pointer; padding:0 4px;">编辑</button>`;
        }
        ownerActions += `<button onclick="window.deleteTopic('${topic.id}')" style="background:transparent; color:#e53e3e; border:none; font-size:11px; cursor:pointer; padding:0 4px;">删除</button>`;
        if (isUserAdmin) {
            ownerActions += `<button onclick="window.warnUser('${topic.user_id}')" style="background:transparent; color:#c53030; border:none; font-size:11px; cursor:pointer; padding:0 4px;">警告</button>`;
        }
        div.innerHTML = `
                <h4 style="margin:0 0 6px 0;">${escapeHtml(topic.title)}</h4>
                <p style="margin:0 0 8px 0; white-space: pre-wrap; font-size:13px;">${escapeHtml(topic.content)}</p>
                
                ${imageHtml}
                
                <div class="flex" style="margin-top:6px; margin-bottom:4px;">
                    <span style="font-size:11px; color:var(--meta-color);">
                        发布者：<b class="clickable-name" onclick="window.viewUserProfile('${topic.user_id}')">${escapeHtml(authorName)}</b>${badge}${topicChatBtn} &nbsp;|&nbsp; 发布于 ${new Date(topic.created_at).toLocaleString()}
                    </span>
                    <!-- 【完整保留】点赞与收藏交互按钮 -->
                    <div style="display:flex; gap:10px; align-items:center;">
                        <button class="action-btn ${isLiked ? 'liked' : ''}" onclick="window.handleLike('${topic.id}', this)" style="background:none; border:none; cursor:pointer; font-size:12px; display:flex; align-items:center; gap:2px; color:${isLiked ? '#e53e3e' : 'var(--meta-color)'};">
                            <span class="like-icon">${isLiked ? '❤️' : '♡'}</span> 
                            <span class="like-count">${likeCount}</span>
                        </button>
                        <button class="action-btn ${isFavorited ? 'favorited' : ''}" onclick="window.handleFavorite('${topic.id}', this)" style="background:none; border:none; cursor:pointer; font-size:12px; display:flex; align-items:center; gap:2px; color:${isFavorited ? '#d69e2e' : 'var(--meta-color)'};">
                            <span class="fav-icon">${isFavorited ? '⭐' : '☆'}</span> 
                        </button>
                    </div>  
                </div>                
                <div style="display: flex; justify-content: flex-end; margin: 4px 0;">
                    ${ownerActions}
                </div> 
                <hr style="border: none; border-top: 1px solid var(--border-color); margin: 8px 0; opacity: 0.5;">
                ${commentsHtml}
                <div style="margin-top:8px; display:flex; gap:6px;">
                    <input type="text" id="comment-input-${topic.id}" placeholder="写下你的评论..." style="font-size:12px; padding:3px 8px; flex:1;">
                    <button onclick="window.createComment('${topic.id}')" style="font-size:12px; padding:3px 12px;">评论</button>
                </div>
            `;            
        container.appendChild(div);
    }

    // 刷新分页按钮状态及页码显示
    updatePaginationUI();

    // 渲染完成：写主体内容快照（非阻塞，失败静默；后台校正渲染同样走此路径，快照自愈）
    saveCurrentContentSnapshot(categoryId);
}

// 翻页触发函数
function changePage(direction) {
    const maxPage = Math.ceil(totalTopicsCount / pageSize) || 1;
    const newPage = currentPage + direction;
    
    if (newPage < 1 || newPage > maxPage) return; // 边界检查
    loadTopics(currentCategoryId, newPage);
}

// 更新分页按钮可用性及页码显示文本
function updatePaginationUI() {
    const maxPage = Math.ceil(totalTopicsCount / pageSize) || 1;
    const pageInfo = document.getElementById('page-info');
    const prevBtn = document.getElementById('prev-page');
    const nextBtn = document.getElementById('next-page');

    // 话题流渲染即恢复分页控件可见（搜索态的隐藏由 performSearch 负责；
    // 非搜索场景该控件本就恒为可见，此行不改变任何既有行为）
    const controls = document.getElementById('pagination-controls');
    if (controls) controls.style.display = 'flex';

    if (pageInfo) pageInfo.innerText = `第 ${currentPage} / ${maxPage} 页`;
    if (prevBtn) prevBtn.disabled = currentPage <= 1;
    if (nextBtn) nextBtn.disabled = currentPage >= maxPage;
}

// ==================== 话题深链机制（US3/US2 枢纽，plan R&D-D4） ====================
// 冷启动 URL 参数快照（同步捕获，仅消费一次）
const initialUrlParams = new URLSearchParams(window.location.search);
let urlParamsConsumed = false;

// 消费 URL 参数（在 initUserSession 档案填充完成后调用，保证 openProfile/深链拿到真实资料，
// 冷启动"先显示后填充"时序不被破坏）：
// ① index.html?topic=<id>&comment=<id> 话题深链定位（comment 可选）
// ② index.html?edit=1 自动打开现有个人中心编辑面板（个人主页"编辑资料"入口消费）
async function consumeUrlParams() {
    if (urlParamsConsumed) return;
    urlParamsConsumed = true;

    const topicParam = initialUrlParams.get('topic');
    const commentParam = initialUrlParams.get('comment');
    const editParam = initialUrlParams.get('edit');

    // 清理已消费参数（保留 pwa_view 等其他参数），避免刷新时重复触发一次性入口
    initialUrlParams.delete('topic');
    initialUrlParams.delete('comment');
    initialUrlParams.delete('edit');
    const remainingQs = initialUrlParams.toString();
    try {
        history.replaceState(null, '', remainingQs ? 'index.html?' + remainingQs : 'index.html');
    } catch (e) {
        // 本地 file:// 等环境异常时忽略，不影响功能
    }

    if (topicParam) {
        // 话题深链：先等默认板块话题流就绪再接管，避免并发渲染相互覆盖
        await categoriesLoadedPromise;
        if (initialTopicsLoadPromise) {
            try { await initialTopicsLoadPromise; } catch (e) { /* 默认流失败不阻断深链 */ }
        }
        handleTopicDeepLink(topicParam, commentParam).catch(() => {
            // 深链失败静默回落（保持当前板块列表，不白屏不报错）
        });
    } else if (editParam === '1') {
        // 自动打开个人中心编辑面板（复用现有 openProfile）
        window.openProfile();
    }
}

// 话题深链：查目标话题（板块/时间）→ count 同板块 created_at 严格更新者算页码
// （page = floor(offset/5)+1，pageSize=5 与现有分页一致）→ 激活对应板块 → loadTopics 渲染
// → 滚动定位目标锚点（优先 #comment-<id>，否则 #topic-<id>）+ 短暂高亮；
// 目标不存在/查询失败 → 静默回落默认板块列表；搜索结果点击复用同一机制（不整页刷新）
async function handleTopicDeepLink(topicId, commentId) {
    // 深链接管即进入板块浏览态：清空搜索框，保持"输入框内容驱动"的状态一致性
    const searchEl = document.getElementById('search-input');
    if (searchEl && searchEl.value) searchEl.value = '';

    try {
        // 查询目标话题（板块/创建时间），不存在或已删除则静默回落
        const { data: targetTopic, error: topicErr } = await db.from('topics').select('category_id, created_at').eq('id', topicId).maybeSingle();
        if (topicErr || !targetTopic || !targetTopic.category_id) {
            if (currentCategoryId) loadTopics(currentCategoryId);
            return;
        }

        // 页码计算：同板块内 created_at 严格更新（更晚）者排在其前面，按每页 5 条换算页码
        const { count: newerCount } = await db.from('topics')
            .select('id', { count: 'exact', head: true })
            .eq('category_id', targetTopic.category_id)
            .gt('created_at', targetTopic.created_at);
        const page = Math.floor((newerCount || 0) / pageSize) + 1;

        // 激活对应板块样式（与板块点击的激活逻辑一致）
        document.querySelectorAll('.category-item').forEach(el => el.classList.remove('active'));
        const activeItem = categoryDomMap[targetTopic.category_id];
        if (activeItem) activeItem.classList.add('active');

        // 渲染目标页话题（分页可见性由 updatePaginationUI 统一恢复）
        await loadTopics(targetTopic.category_id, page);

        // 渲染完成后滚动定位：优先评论锚点，其次话题锚点；短暂高亮提示定位目标（不遮挡内容）
        const anchor = (commentId && document.getElementById('comment-' + commentId)) || document.getElementById('topic-' + topicId);
        if (anchor) {
            anchor.scrollIntoView({ behavior: 'smooth', block: 'center' });
            anchor.style.transition = 'box-shadow 0.3s';
            anchor.style.boxShadow = '0 0 0 3px var(--primary-color)';
            setTimeout(() => {
                anchor.style.boxShadow = '';
            }, 2000);
        }
    } catch (e) {
        // 任何异常静默回落默认板块列表（不白屏不报错）
        if (currentCategoryId) loadTopics(currentCategoryId);
    }
}

// ==================== 站内搜索模块（US2，plan R&D-D5） ====================
// 搜索态与板块浏览态互斥，由搜索框内容驱动；350ms 防抖（setTimeout 竞态清除，一次停顿至多一次请求）
let searchTimer = null;

// LIKE 通配符转义：% _ \ 前加反斜杠，保证关键词按字面量安全匹配（不引发查询异常与注入）
function escapeLikePattern(keyword) {
    return keyword.replace(/[\\%_]/g, '\\$&');
}

// 头像显示白名单：仅采用以 data:image/ 或 http 开头的取值，空值与脏数据回退 icon.png（同 bridge.html 口径）
function searchAvatarSrc(avatarUrl) {
    const url = typeof avatarUrl === 'string' ? avatarUrl : '';
    return (url.startsWith('data:image/') || url.startsWith('http')) ? url : 'icon.png';
}

// 执行搜索：话题两路 ilike 查询合并去重 + 成员昵称查询，结果渲染到 topics-container
async function performSearch(rawKeyword) {
    let keyword = (rawKeyword || '').trim();
    if (!keyword) {
        // 空关键词：恢复当前板块的正常话题列表与分页（分页可见性由 updatePaginationUI 统一恢复）
        loadTopics(currentCategoryId);
        return;
    }
    // 超长关键词截断，不发起无意义查询
    if (keyword.length > 50) keyword = keyword.slice(0, 50);
    const pattern = '%' + escapeLikePattern(keyword) + '%';

    const container = document.getElementById('topics-container');
    container.innerHTML = '<p style="font-size:13px; color:var(--meta-color);">搜索中...</p>';
    // 搜索态隐藏分页控件（清空搜索框后随话题流渲染恢复）
    document.getElementById('pagination-controls').style.display = 'none';

    // 话题两路独立查询（标题/内容各 limit 20）+ 成员昵称查询（limit 20）
    // 不用 .or('title.ilike...,content.ilike...')：PostgREST or 表达式中关键词含逗号会破坏解析
    const [titleRes, contentRes, memberRes] = await Promise.all([
        db.from('topics').select('*').ilike('title', pattern).order('created_at', { ascending: false }).limit(20),
        db.from('topics').select('*').ilike('content', pattern).order('created_at', { ascending: false }).limit(20),
        db.from('profiles').select('id, nickname, grade, avatar_url, is_admin').ilike('nickname', pattern).limit(20)
    ]);

    // 话题按 id 合并去重（标题命中在前，保持时间倒序）
    const mergedMap = {};
    const mergedTopics = [];
    if (titleRes.data) {
        titleRes.data.forEach(t => {
            if (!mergedMap[t.id]) { mergedMap[t.id] = true; mergedTopics.push(t); }
        });
    }
    if (contentRes.data) {
        contentRes.data.forEach(t => {
            if (!mergedMap[t.id]) { mergedMap[t.id] = true; mergedTopics.push(t); }
        });
    }
    const members = memberRes.data || [];

    container.innerHTML = '';
    if (mergedTopics.length === 0 && members.length === 0) {
        container.innerHTML = '<div class="card"><p style="font-size:13px; color:var(--meta-color); margin:0;">未找到相关内容</p></div>';
        return;
    }

    // 成员结果区：头像白名单/昵称/年级/管理员徽章，点击进入其个人主页
    if (members.length > 0) {
        const memberCard = document.createElement('div');
        memberCard.className = 'card';
        memberCard.innerHTML = `<h4 style="margin:0 0 8px 0;">相关成员（${members.length}）</h4>`;
        const memberGrid = document.createElement('div');
        memberGrid.className = 'search-member-grid';
        members.forEach(m => {
            const itemEl = document.createElement('div');
            itemEl.className = 'search-member-item';
            itemEl.innerHTML = `
                <img src="${escapeHtml(searchAvatarSrc(m.avatar_url))}" alt="头像" class="search-member-avatar">
                <div style="overflow:hidden;">
                    <div style="display:flex; align-items:center; gap:5px;">
                        <b style="font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(m.nickname || '未命名用户')}</b>
                        ${m.is_admin ? '<span class="badge-admin">管理员</span>' : ''}
                    </div>
                    <div style="font-size:11px; color:var(--meta-color);">年级：${escapeHtml(m.grade || '未填')}</div>
                </div>
            `;
            // 点击成员结果进入其个人主页（事件绑定，不内联拼接用户数据）
            itemEl.onclick = () => {
                window.location.href = 'profile.html?id=' + encodeURIComponent(m.id);
            };
            // 站内私信入口（US2）：搜索成员卡片"发消息"小按钮，自己对自己不出现
            if (currentAuthUser && currentAuthUser.id !== m.id) {
                const chatBtn = document.createElement('button');
                chatBtn.type = 'button';
                chatBtn.textContent = '发消息';
                chatBtn.style.cssText = 'flex-shrink:0; margin-left:8px; padding:2px 8px; font-size:11px; background:#4a5568;';
                chatBtn.onclick = (ev) => {
                    ev.stopPropagation(); // 不触发卡片整卡跳个人主页的既有行为
                    window.startChatWith(m.id);
                };
                itemEl.appendChild(chatBtn);
            }
            memberGrid.appendChild(itemEl);
        });
        memberCard.appendChild(memberGrid);
        container.appendChild(memberCard);
    }

    // 话题结果区：标题/内容摘要/作者/板块名/时间/点赞评论计数，点击内联调用话题深链定位
    if (mergedTopics.length > 0) {
        // 作者昵称映射（仅按需查询命中话题涉及的用户）
        const userIdSet = new Set();
        mergedTopics.forEach(t => userIdSet.add(t.user_id));
        const authorMap = {};
        const userIds = Array.from(userIdSet);
        if (userIds.length > 0) {
            const { data: profilesData } = await db.from('profiles').select('id, nickname, is_admin').in('id', userIds);
            if (profilesData) {
                profilesData.forEach(p => { authorMap[p.id] = p; });
            }
        }
        // 点赞/评论计数映射（模式对齐 loadTopics）
        const topicIds = mergedTopics.map(t => t.id);
        const likeCountMap = {};
        const commentCountMap = {};
        if (topicIds.length > 0) {
            const { data: likeRows } = await db.from('likes').select('topic_id').in('topic_id', topicIds);
            if (likeRows) {
                likeRows.forEach(l => { likeCountMap[l.topic_id] = (likeCountMap[l.topic_id] || 0) + 1; });
            }
            const { data: commentRows } = await db.from('comments').select('topic_id').in('topic_id', topicIds);
            if (commentRows) {
                commentRows.forEach(c => { commentCountMap[c.topic_id] = (commentCountMap[c.topic_id] || 0) + 1; });
            }
        }

        const topicCard = document.createElement('div');
        topicCard.className = 'card';
        topicCard.innerHTML = `<h4 style="margin:0 0 8px 0;">相关话题（${mergedTopics.length}）</h4>`;
        mergedTopics.forEach(topic => {
            const author = authorMap[topic.user_id];
            const authorName = author ? author.nickname : (topic.user_name || '匿名用户');
            const catName = categoryNameMap[topic.category_id] || '未知板块';
            const rawContent = topic.content || '';
            const excerpt = rawContent.length > 80 ? rawContent.slice(0, 80) + '...' : rawContent;
            const itemEl = document.createElement('div');
            itemEl.className = 'search-topic-item';
            itemEl.innerHTML = `
                <div style="font-weight:600; font-size:14px;">${escapeHtml(topic.title)}</div>
                <div style="font-size:12px; color:var(--meta-color); margin-top:2px;">${escapeHtml(excerpt)}</div>
                <div style="font-size:11px; color:var(--meta-color); margin-top:4px;">
                    ${escapeHtml(authorName)}${author && author.is_admin ? ' <span class="badge-admin">管理员</span>' : ''} &nbsp;|&nbsp; ${escapeHtml(catName)} &nbsp;|&nbsp; ${new Date(topic.created_at).toLocaleString()} &nbsp;|&nbsp; 👍 ${likeCountMap[topic.id] || 0} &nbsp; 💬 ${commentCountMap[topic.id] || 0}
                </div>
            `;
            // 点击搜索结果话题：内联调用话题深链定位（不整页刷新）
            itemEl.onclick = () => {
                handleTopicDeepLink(topic.id);
            };
            topicCard.appendChild(itemEl);
        });
        container.appendChild(topicCard);
    }
}

// 搜索框输入监听：350ms 防抖（setTimeout 竞态清除，连续快速输入仅发起一次搜索请求）
const searchInputEl = document.getElementById('search-input');
if (searchInputEl) {
    searchInputEl.addEventListener('input', () => {
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            searchTimer = null;
            performSearch(searchInputEl.value);
        }, 350);
    });
}

// 点赞处理函数
window.handleLike = async function(postId, btnElement) {
    if (!currentAuthUser) {
        alert("请先登录");
        return;
    }

    const iconSpan = btnElement.querySelector('.like-icon');
    const countSpan = btnElement.querySelector('.like-count');
    let currentCount = parseInt(countSpan.textContent) || 0;
    const isCurrentlyLiked = btnElement.classList.contains('liked');

    // 1. 立即更新前端 UI 状态
    if (isCurrentlyLiked) {
        btnElement.classList.remove('liked');
        btnElement.style.color = 'var(--meta-color)';
        iconSpan.textContent = '♡';
        countSpan.textContent = Math.max(0, currentCount - 1);
    } else {
        btnElement.classList.add('liked');
        btnElement.style.color = '#e53e3e';
        iconSpan.textContent = '❤️';
        countSpan.textContent = currentCount + 1;
    }

    // 2. 真实写入数据库
    try {
        if (isCurrentlyLiked) {
            const { error } = await db.from('likes')
                .delete()
                .eq('topic_id', postId)
                .eq('user_id', currentAuthUser.id);
            if (error) throw error;
        } else {
            const { error } = await db.from('likes')
                .insert({ topic_id: postId, user_id: currentAuthUser.id });
            if (error) throw error;
        }
    } catch (error) {
        console.error("点赞同步后台失败:", error.message);
        alert("点赞同步失败: " + error.message);
        
        // 发生错误时回滚前端 UI 状态
        if (isCurrentlyLiked) {
            btnElement.classList.add('liked');
            btnElement.style.color = '#e53e3e';
            iconSpan.textContent = '❤️';
            countSpan.textContent = currentCount;
        } else {
            btnElement.classList.remove('liked');
            btnElement.style.color = 'var(--meta-color)';
            iconSpan.textContent = '♡';
            countSpan.textContent = currentCount;
        }
    }
};

// 收藏处理函数
window.handleFavorite = async function(postId, btnElement) {
    if (!currentAuthUser) {
        alert("请先登录");
        return;
    }

    const iconSpan = btnElement.querySelector('.fav-icon');
    const isCurrentlyFavorited = btnElement.classList.contains('favorited');

    // 1. 立即更新前端 UI 状态
    if (isCurrentlyFavorited) {
        btnElement.classList.remove('favorited');
        btnElement.style.color = 'var(--meta-color)';
        iconSpan.textContent = '☆';
    } else {
        btnElement.classList.add('favorited');
        btnElement.style.color = '#d69e2e';
        iconSpan.textContent = '⭐';
    }

    // 2. 真实写入数据库
    try {
        if (isCurrentlyFavorited) {
            const { error } = await db.from('favorites')
                .delete()
                .eq('topic_id', postId)
                .eq('user_id', currentAuthUser.id);
            if (error) throw error;
        } else {
            const { error } = await db.from('favorites')
                .insert({ topic_id: postId, user_id: currentAuthUser.id });
            if (error) throw error;
        }
    } catch (error) {
        console.error("收藏同步后台失败:", error.message);
        alert("收藏同步失败: " + error.message);
        
        // 发生错误时回滚前端 UI 状态
        if (isCurrentlyFavorited) {
            btnElement.classList.add('favorited');
            btnElement.style.color = '#d69e2e';
            iconSpan.textContent = '⭐';
        } else {
            btnElement.classList.remove('favorited');
            btnElement.style.color = 'var(--meta-color)';
            iconSpan.textContent = '☆';
        }
    }
};

// 压缩图片的辅助函数（限制最大宽度/高度和文件大小）
function compressImage(file, maxWidth = 1920, maxHeight = 2880, quality = 0.88) {
    return new Promise((resolve, reject) => {
        // 如果不是图片文件，直接返回原文件
        if (!file.type.startsWith('image/')) {
            resolve(file);
            return;
        }

        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = (event) => {
            const img = new Image();
            img.src = event.target.result;
            img.onload = () => {
                let width = img.width;
                let height = img.height;

                // 等比例缩放计算
                if (width > maxWidth || height > maxHeight) {
                    if (width / height > maxWidth / maxHeight) {
                        height = Math.round((height * maxWidth) / width);
                        width = maxWidth;
                    } else {
                        width = Math.round((width * maxHeight) / height);
                        height = maxHeight;
                    }
                }

                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                // 导出为 Blob / File
                canvas.toBlob(
                    (blob) => {
                        if (!blob) {
                            reject(new Error('图片压缩失败'));
                            return;
                        }
                        // 保持原文件名和类型
                        const compressedFile = new File([blob], file.name, {
                            type: file.type,
                            lastModified: Date.now(),
                        });
                        resolve(compressedFile);
                    },
                    file.type,
                    quality // 压缩质量 (0 ~ 1)
                );
            };
            img.onerror = (error) => reject(error);
        };
        reader.onerror = (error) => reject(error);
    });
}
    
window.replyToUser = function(topicId, commentUserId) {
    // 从当前页相关用户档案映射回查评论者昵称
    const profile = currentProfileMap[commentUserId];
    const authorName = profile ? profile.nickname : '匿名用户';
    const input = document.getElementById(`comment-input-${topicId}`);
    if (input) {
        input.value = `@${authorName} `;
        input.focus();
    }
};

window.createTopic = async function() {
    const title = document.getElementById('topic-title').value.trim();
    let content = document.getElementById('topic-content').value.trim();
    if (!title || !content) {
        alert('标题和内容不能为空！');
        return;
    }
    if (!currentCategoryId) {
        alert('请先选择一个讨论板块！');
        return;
    }

    let finalimageUrl = '';
    const submitBtn = document.getElementById('post-submit-btn');

    // 1. 如果用户选择了图片，通过 FormData 提交给 Supabase 边缘函数中转上传至 R2
        if (selectedImageFile) {
            try {

                let fileToUpload = selectedImageFile;

                // 如果图片大小超过 1.6MB，才执行压缩
                if (selectedImageFile.size > 1.6 * 1024 * 1024) {
                    if (submitBtn) submitBtn.innerText = '正在压缩图片...';
                    fileToUpload = await compressImage(selectedImageFile, 1200, 1200, 0.8);
                }
                
                if (submitBtn) submitBtn.innerText = '上传图片中...';
                // 构造 FormData
                const formData = new FormData();
                formData.append('file', fileToUpload);

                // 请求 Supabase Edge Function 中转上传（地址由共享配置派生，全库仅 config.js 一份）
                const res = await fetch(window.LT_CONFIG.SUPABASE_URL + '/functions/v1/upload-r2', {
                    method: 'POST',
                    headers: { 
                        // 带上 Supabase 客户端自带的 Anon 公钥，解决 401 拦截
                        'Authorization': `Bearer ${db.supabaseKey}` 
                    },
                    body: formData
                });

                const data = await res.json();
                if (!res.ok) throw new Error(data.error || '图片中转上传失败');

                finalimageUrl = data.publicUrl || data.url; // 获取后端返回的 R2 图片外链
            } catch (err) {
                alert('图片上传出错: ' + err.message);
                if (submitBtn) submitBtn.innerText = '发布话题';
                return;
            }
        }

    if (submitBtn) submitBtn.innerText = '发布中...';
    
    const { error } = await db.from('topics').insert({
        category_id: currentCategoryId,
        user_id: currentAuthUser.id,
        user_name: currentUserProfile.nickname || '匿名用户',
        title,
        content,
        image_url: finalimageUrl // 如果你的表结构有 image_url 字段，在这里存入 R2 链接
    });

    if (submitBtn) submitBtn.innerText = '发布话题';

    if (error) {
        alert('发布失败: ' + error.message);
    } else {
        document.getElementById('topic-title').value = '';
        document.getElementById('topic-content').value = '';

        const fileInput = document.getElementById('topic-image-file');
        if (fileInput) fileInput.value = '';
        selectedImageFile = null;

        const previewEl = document.getElementById('image-preview-container');
        if (previewEl) previewEl.innerHTML = '';
        
        loadTopics(currentCategoryId);
    }
};

window.createComment = async function(topicId) {
    const input = document.getElementById(`comment-input-${topicId}`);
    const content = input.value.trim();
    if (!content) return alert('评论内容不能为空！');

    // insert 增 .select('id').single() 取回评论 id（供 @提及通知定位评论锚点；插入字段与对外行为不变）
    const { data: insertedComment, error } = await db.from('comments').insert({
        topic_id: topicId,
        user_id: currentAuthUser.id,
        user_name: currentUserProfile.nickname || '匿名用户',
        content
    }).select('id').single();

    if (error) {
        alert('评论失败: ' + error.message);
    } else {
        input.value = '';
        loadTopics(currentCategoryId);
        // 评论成功后异步投递 @提及通知（不阻塞评论发布路径，失败静默降级）
        // 回复按钮预填的 `@昵称 ` 与手打 @ 自然走同一解析路径
        if (insertedComment && insertedComment.id) {
            sendMentionNotifications(topicId, insertedComment.id, content).catch(() => {});
        }
    }
};

// @提及解析与通知投递（US3，plan R&D-D2/D3）：正则提取正文 @token → 去重 → 昵称精确匹配成员
// （同名全收，宁多勿漏）→ 排除评论者本人 → 组装通知数组（content 尾部携带跳转定位标记）→ 批量插入；
// 全程静默降级，评论发布永不受提及功能受阻
async function sendMentionNotifications(topicId, commentId, content) {
    // 正则提取 @提及 token（@ 后跟非空白非@的连续字符），同人去重
    const tokens = [];
    const seenTokens = new Set();
    const mentionRegex = /@([^\s@]+)/g;
    let match;
    while ((match = mentionRegex.exec(content)) !== null) {
        const token = match[1];
        if (token && !seenTokens.has(token)) {
            seenTokens.add(token);
            tokens.push(token);
        }
    }
    if (tokens.length === 0) return;

    // 昵称精确匹配（in 查询，同名成员全部命中）
    const { data: mentionedProfiles } = await db.from('profiles').select('id, nickname').in('nickname', tokens);
    if (!mentionedProfiles || mentionedProfiles.length === 0) return;

    // 排除评论者本人（自我提及忽略）
    const recipients = mentionedProfiles.filter(p => p.id !== currentAuthUser.id);
    if (recipients.length === 0) return;

    // 查询所属话题标题（用于通知文案；话题已删除则使用占位文案）
    const { data: topicRow } = await db.from('topics').select('title').eq('id', topicId).maybeSingle();
    const topicTitle = (topicRow && topicRow.title) ? topicRow.title : '已删除的话题';

    const commenterName = currentUserProfile.nickname || '匿名用户';
    // 通知 content 尾部携带跳转定位标记 [[t:<topicId>,c:<commentId>]]，
    // 与 loadNotifications 渲染时的标记解析逻辑严格互逆
    const notificationsData = recipients.map(p => ({
        user_id: p.id,
        title: '💬 有人提到了你',
        content: `${commenterName} 在《${topicTitle}》中提到了你 [[t:${topicId},c:${commentId}]]`,
        is_read: false
    }));

    await db.from('notifications').insert(notificationsData);
}

window.deleteComment = async function(commentId) {
    if (!confirm('确定要删除这条评论吗？')) return;
    const { error } = await db.from('comments').delete().eq('id', commentId);
    if (error) {
        alert('删除评论失败: ' + error.message);
    } else {
        loadTopics(currentCategoryId);
    }
};

window.warnUser = async function(userId) {
    const reason = prompt('请输入对该用户进行警告或限流的原因（将自动生成系统通知发送给对方）：');
    if (!reason) return;

    await db.from('notifications').insert({
        user_id: userId,
        title: '⚠️ 违规警告通知',
        content: `您在论坛发布的内容由于违规已被管理员处理。原因：${reason}`,
        is_read: false
    });

    alert('已成功向该用户发出警告并发送通知！');
};

window.openEditModal = function(topicId) {
    // 从当前页话题内存映射回查标题与内容，避免内联拼接用户文本
    const topic = currentTopicsMap[topicId];
    if (!topic) return;
    document.getElementById('edit-topic-id').value = topicId;
    document.getElementById('edit-topic-title').value = topic.title;
    document.getElementById('edit-topic-content').value = topic.content;
    document.getElementById('edit-modal').classList.remove('hidden');
};

window.closeEditModal = function() {
    document.getElementById('edit-modal').classList.add('hidden');
};

window.saveEditedTopic = async function() {
    const id = document.getElementById('edit-topic-id').value;
    const title = document.getElementById('edit-topic-title').value.trim();
    const content = document.getElementById('edit-topic-content').value.trim();
    if (!title || !content) {
        alert('标题和内容不能为空！');
        return;
    }
    const { error } = await db.from('topics').update({ title, content }).eq('id', id);
    if (error) {
        alert('修改失败: ' + error.message);
    } else {
        window.closeEditModal();
        loadTopics(currentCategoryId);
    }
};

window.deleteTopic = async function(id) {
    if (!confirm('确定要删除该话题吗？')) return;
    const { error } = await db.from('topics').delete().eq('id', id);
    if (error) {
        alert('删除失败: ' + error.message);
    } else {
        loadTopics(currentCategoryId);
    }
};

// 查看用户资料：跳转该成员的个人主页 profile.html（旧资料弹窗已由个人主页取代）
// 保留函数名与签名，话题作者/评论者等全部既有 onclick 绑定零改动；隐私展示口径已迁移至 profile.html
window.viewUserProfile = function(userId) {
    window.location.href = 'profile.html?id=' + encodeURIComponent(userId);
};
