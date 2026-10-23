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

    // 论坛先显示：不再被 profiles 查询的网络往返阻塞，分类/列表加载（loadCategories）立即启动
    showForum();
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

function showForum() {
    document.getElementById('auth-section').classList.add('hidden');
    document.getElementById('profile-section').classList.add('hidden');
    document.getElementById('forum-section').classList.remove('hidden');
    loadCategories();
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
        div.innerHTML = `
            <div class="flex" style="margin-bottom:4px;">
                <b>${escapeHtml(notif.title)}</b>
                <span style="font-size:11px; color:var(--meta-color);">${new Date(notif.created_at).toLocaleString()}</span>
            </div>
            <p style="margin:0;">${escapeHtml(notif.content)}</p>
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

async function loadCategories() {
    const container = document.getElementById('categories-list');
    const { data, error } = await db.from('categories').select('*').order('id', { ascending: true });
    if (error || !data || data.length === 0) {
        container.innerHTML = '<p style="font-size:12px; color:var(--meta-color);">暂无板块</p>';
        return;
    }
    container.innerHTML = '';
    data.forEach((cat, index) => {
        const div = document.createElement('div');
        div.className = 'category-item' + (index === 0 ? ' active' : '');
        div.innerText = cat.name;
        div.onclick = () => {
            document.querySelectorAll('.category-item').forEach(el => el.classList.remove('active'));
            div.classList.add('active');
            currentCategoryId = cat.id;
            loadTopics(cat.id);
        };
        container.appendChild(div);
    });
    if (data.length > 0) {
        currentCategoryId = data[0].id;
        loadTopics(data[0].id);
    }
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

            let commentActions = '';
            if (canDeleteComment) {
                commentActions += `<button onclick="window.deleteComment('${comment.id}')" style="background:transparent; color:#e53e3e; border:none; font-size:11px; cursor:pointer; padding:0 4px;">删除</button>`;
            }
            commentsHtml += `
                <div style="font-size:12px; margin-top:3px; padding-bottom:2px; display:flex; justify-content:space-between; align-items:center;">
                    <div>
                        <span class="clickable-name" onclick="window.viewUserProfile('${comment.user_id}')">${escapeHtml(commentAuthor)}</span><b>:</b> ${escapeHtml(comment.content)} ${timeHtml} ${replyAction}
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
                        发布者：<b class="clickable-name" onclick="window.viewUserProfile('${topic.user_id}')">${escapeHtml(authorName)}</b>${badge} &nbsp;|&nbsp; 发布于 ${new Date(topic.created_at).toLocaleString()}
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

    if (pageInfo) pageInfo.innerText = `第 ${currentPage} / ${maxPage} 页`;
    if (prevBtn) prevBtn.disabled = currentPage <= 1;
    if (nextBtn) nextBtn.disabled = currentPage >= maxPage;
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
    
    const { error } = await db.from('comments').insert({
        topic_id: topicId,
        user_id: currentAuthUser.id,
        user_name: currentUserProfile.nickname || '匿名用户',
        content
    });
    
    if (error) {
        alert('评论失败: ' + error.message);
    } else {
        input.value = '';
        loadTopics(currentCategoryId);
    }
};

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

window.viewUserProfile = async function(userId) {
    const modalContent = document.getElementById('modal-user-content');
    const modalTitle = document.getElementById('modal-title');
    modalContent.innerHTML = '加载中...';
    document.getElementById('user-modal').classList.remove('hidden');

    const { data: profile, error } = await db.from('profiles').select('*').eq('id', userId).single();
    if (error || !profile) {
        modalContent.innerHTML = '<p style="color:red; font-size:13px;">无法获取该用户资料或用户已注销。</p>';
        return;
    }

    modalTitle.innerText = `${profile.nickname || '用户'} 的个人资料`;
    const isAdminViewer = currentUserProfile && currentUserProfile.is_admin;
    
    let html = `<div style="font-size:13px; display:flex; flex-direction:column; gap:6px;">`;
    html += `<div><b>身份：</b>${profile.is_admin ? '🛡️ 管理员 (Admin)' : '普通成员'}</div>`;
    // 年级强制向外展示
    html += `<div><b>年级：</b> ${escapeHtml(profile.grade || '未填写')}</div>`;
    if ((isAdminViewer || profile.public_email) && profile.email) {
        const isBypassed = !profile.public_email && isAdminViewer;
        html += `<div><b>绑定邮箱：</b>${escapeHtml(profile.email)} ${isBypassed ? '<span style="color:#e53e3e; font-size:11px;">(管理员特权可见)</span>' : ''}</div>`;
    }

    if ((isAdminViewer || profile.public_real_name) && profile.real_name) {
        const isBypassed = !profile.public_real_name && isAdminViewer;
        html += `<div><b>真实姓名：</b>${escapeHtml(profile.real_name)} ${isBypassed ? '<span style="color:#e53e3e; font-size:11px;">(管理员特权可见)</span>' : ''}</div>`;
    }

    if ((isAdminViewer || profile.public_phone) && profile.phone) {
        const isBypassed = !profile.public_phone && isAdminViewer;
        html += `<div><b>手机号：</b>${escapeHtml(profile.phone)} ${isBypassed ? '<span style="color:#e53e3e; font-size:11px;">(管理员特权可见)</span>' : ''}</div>`;
    }

    if ((isAdminViewer || profile.public_gender !== false) && profile.gender) {
        const isBypassed = profile.public_gender === false && isAdminViewer;
        html += `<div><b>性别：</b>${escapeHtml(profile.gender)} ${isBypassed ? '<span style="color:#e53e3e; font-size:11px;">(管理员特权可见)</span>' : ''}</div>`;
    }

    if ((isAdminViewer || profile.public_age !== false) && profile.age) {
        const isBypassed = profile.public_age === false && isAdminViewer;
        html += `<div><b>年龄：</b>${escapeHtml(profile.age)} ${isBypassed ? '<span style="color:#e53e3e; font-size:11px;">(管理员特权可见)</span>' : ''}</div>`;
    }

    if ((isAdminViewer || profile.public_birthday !== false) && profile.birthday) {
        const isBypassed = profile.public_birthday === false && isAdminViewer;
        html += `<div><b>生日：</b>${escapeHtml(profile.birthday)} ${isBypassed ? '<span style="color:#e53e3e; font-size:11px;">(管理员特权可见)</span>' : ''}</div>`;
    }

    if ((isAdminViewer || profile.public_constellation !== false) && profile.constellation) {
        const isBypassed = profile.public_constellation === false && isAdminViewer;
        html += `<div><b>星座：</b>${escapeHtml(profile.constellation)} ${isBypassed ? '<span style="color:#e53e3e; font-size:11px;">(管理员特权可见)</span>' : ''}</div>`;
    }

    if ((isAdminViewer || profile.public_hometown !== false) && profile.hometown) {
        const isBypassed = profile.public_hometown === false && isAdminViewer;
        html += `<div><b>故乡：</b>${escapeHtml(profile.hometown)} ${isBypassed ? '<span style="color:#e53e3e; font-size:11px;">(管理员特权可见)</span>' : ''}</div>`;
    }
    
    html += `</div>`;
    modalContent.innerHTML = html;
};

window.closeUserModal = function() {
    document.getElementById('user-modal').classList.add('hidden');
};
