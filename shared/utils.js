/**
 * 共通工具函数
 * 依赖 shared/constants.js（需在此文件前加载）
 */

// ─── 时序工具 ───

/** 在 base ± jitter 范围内取随机值（结果不小于 base 的一半） */
function jitter(base, jitterRange) {
    const offset = (Math.random() * 2 - 1) * jitterRange;
    return Math.max(base / 2, base + offset);
}

/** Promise 化的 sleep */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Cookie 工具 ───

/** Cookie 对象 → 完整 URL（用于 chrome.cookies.set/remove） */
function cookieToUrl(c) {
    const pfx = c.secure ? "https://" : "http://";
    const domain = c.domain.startsWith(".") ? c.domain.substring(1) : c.domain;
    return pfx + domain + c.path;
}

/**
 * 清除所有 QCC Cookie
 * @param {string} [storeId] 指定 Cookie 容器；省略则操作默认容器
 */
async function clearAllQccCookies(storeId) {
    const query = { domain: QCC_DOMAIN };
    if (storeId) query.storeId = storeId;
    const cookies = await chrome.cookies.getAll(query);
    await Promise.all(cookies.map(c => {
        const params = { url: cookieToUrl(c), name: c.name };
        if (storeId) params.storeId = storeId;
        return chrome.cookies.remove(params).catch(() => { });
    }));
}

/**
 * 批量注入 Cookie 数组到浏览器（静默失败）
 * @param {Array} cookies 待注入的 Cookie 数组
 * @param {string} [storeId] 目标 Cookie 容器；省略则沿用各 Cookie 自带的 storeId
 */
async function injectCookies(cookies, storeId) {
    await Promise.all((cookies || []).map(c =>
        chrome.cookies.set({
            url: cookieToUrl(c),
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            secure: c.secure,
            httpOnly: c.httpOnly,
            sameSite: c.sameSite,
            expirationDate: c.expirationDate,
            storeId: storeId || c.storeId
        }).catch(() => { })
    ));
}

/**
 * 从 Cookie 数组中提取核心 Cookie 的最大过期时间
 * @returns {{ maxExpiry: number, hasCore: boolean }}
 */
function calcMaxExpiry(cookies) {
    let maxExpiry = 0;
    let hasCore = false;
    for (const c of (cookies || [])) {
        if (CORE_COOKIE_NAMES.includes(c.name)) {
            if (c.expirationDate && c.expirationDate > maxExpiry) {
                maxExpiry = c.expirationDate;
            }
            hasCore = true;
        }
    }
    return { maxExpiry, hasCore };
}

/**
 * 确保 maxExpiry 有效：无核心 Cookie 时使用默认值
 * @returns {number} 修正后的 maxExpiry
 */
function ensureExpiry(maxExpiry, hasCore) {
    if (!hasCore || maxExpiry === 0) {
        return Math.floor(Date.now() / 1000) + DEFAULT_EXPIRY_SEC;
    }
    return maxExpiry;
}

/** Cookie 精简映射（去除 storeId 等运行时字段，减少存储/传输体积） */
function slimCookie(c) {
    return {
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        expirationDate: c.expirationDate
    };
}

// ─── LocalStorage 工具 ───

/** 判断 LocalStorage 键值对是否需要保留 */
function isValidLsEntry(key, value) {
    if (!value || value.length >= LS_MAX_VALUE_LENGTH) return false;
    const lk = key.toLowerCase();
    if (LS_EXCLUDE_PATTERNS.some(p => lk.includes(p))) return false;
    if (LS_EXCLUDE_KEYS.includes(key)) return false;
    if (LS_EXCLUDE_PREFIXES.some(p => key.includes(p))) return false;
    return true;
}

/** 过滤 LocalStorage 对象，仅保留有效条目 */
function filterLocalStorage(lsData) {
    if (!lsData) return {};
    const result = {};
    for (const k in lsData) {
        if (isValidLsEntry(k, lsData[k])) {
            result[k] = lsData[k];
        }
    }
    return result;
}

// ─── 配置存储 ───

/**
 * 读取同步配置（WebDAV 参数 + autoSync 开关）
 *
 * 存于 chrome.storage.sync，登录同一 Google 账号的浏览器自动同步，
 * 换设备无需重填。账号数据（accounts / lastUploadAt 等）体积远超
 * sync 的单项 8KB 限制，仍留在 chrome.storage.local。
 *
 * 首次读取时若 sync 为空而 local 有旧值，则自动迁移过去。
 */
async function getSyncedConfig() {
    const synced = await chrome.storage.sync.get({ webdav: null, autoSync: null });

    // 旧版本配置存在 local，此处一次性迁移
    if (synced.webdav === null && synced.autoSync === null) {
        const legacy = await chrome.storage.local.get({ webdav: null, autoSync: true });
        if (legacy.webdav) {
            await setSyncedConfig({ webdav: legacy.webdav, autoSync: legacy.autoSync });
            // 迁移完成后清掉 local 副本，避免密码在两处重复留存
            await chrome.storage.local.remove(["webdav", "autoSync"]);
            return { webdav: legacy.webdav, autoSync: legacy.autoSync };
        }
    }

    return {
        webdav: synced.webdav,
        autoSync: synced.autoSync === null ? true : synced.autoSync
    };
}

/** 写入同步配置；仅传入的字段会被更新 */
async function setSyncedConfig({ webdav, autoSync }) {
    const patch = {};
    if (webdav !== undefined) patch.webdav = webdav;
    if (autoSync !== undefined) patch.autoSync = autoSync;
    await chrome.storage.sync.set(patch);
}

// ─── WebDAV 工具 ───

/** 规范化 WebDAV base URL（确保以 / 结尾） */
function normalizeBaseUrl(url) {
    return url.endsWith("/") ? url : url + "/";
}

/**
 * 构造 WebDAV Basic Auth 请求头
 * 密码可能含非 ASCII 字符（中文、全角符号），btoa 只接受 Latin-1，
 * 直接传入会抛 InvalidCharacterError，故先按 UTF-8 编码再转 base64。
 */
function buildWebdavHeaders(config) {
    const headers = {};
    if (config.user || config.pass) {
        const raw = (config.user || "") + ":" + (config.pass || "");
        const bytes = new TextEncoder().encode(raw);
        let latin1 = "";
        for (const b of bytes) latin1 += String.fromCharCode(b);
        headers["Authorization"] = "Basic " + btoa(latin1);
    }
    return headers;
}

/**
 * WebDAV 专用 fetch：统一 credentials: "omit"
 *
 * 关键点：fetch 默认 credentials 为 "same-origin"，WebDAV 属跨源请求，
 * 浏览器会在收到 401 时接管请求并弹出原生 Basic Auth 认证框，
 * 401 也就不会返回给调用方。改为 "omit" 后浏览器不再介入，
 * 我们自带的 Authorization 头成为唯一凭据，401 可被代码捕获处理。
 */
function webdavFetch(url, init = {}) {
    return fetch(url, { ...init, credentials: "omit" });
}

/** 把 WebDAV 响应状态码翻译成可读的错误信息；正常则返回 null */
function describeWebdavError(status) {
    if (status === 401) return "认证失败 (401)：WebDAV 用户名或密码不正确，请在配置页重新填写。";
    if (status === 403) return "拒绝访问 (403)：该账号无权读写此目录。";
    if (status === 404) return "路径不存在 (404)：请检查 WebDAV URL 中的目录是否正确。";
    if (status === 409) return "目录缺失 (409)：远端父目录不存在，无法写入文件。";
    if (status >= 500) return `服务器错误 (${status})：WebDAV 服务端异常。`;
    return null;
}
