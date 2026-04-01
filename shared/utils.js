/**
 * 共通工具函数
 * 依赖 shared/constants.js（需在此文件前加载）
 */

// ─── Cookie 工具 ───

/** Cookie 对象 → 完整 URL（用于 chrome.cookies.set/remove） */
function cookieToUrl(c) {
    const pfx = c.secure ? "https://" : "http://";
    const domain = c.domain.startsWith(".") ? c.domain.substring(1) : c.domain;
    return pfx + domain + c.path;
}

/** 清除所有 QCC Cookie */
async function clearAllQccCookies() {
    const cookies = await chrome.cookies.getAll({ domain: QCC_DOMAIN });
    await Promise.all(cookies.map(c =>
        chrome.cookies.remove({ url: cookieToUrl(c), name: c.name })
    ));
}

/** 批量注入 Cookie 数组到浏览器（静默失败） */
async function injectCookies(cookies) {
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
            storeId: c.storeId
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

/** Cookie 精简映射（去除 storeId/httpOnly 等，减少存储/传输体积） */
function slimCookie(c) {
    return {
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
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

// ─── WebDAV 工具 ───

/** 规范化 WebDAV base URL（确保以 / 结尾） */
function normalizeBaseUrl(url) {
    return url.endsWith("/") ? url : url + "/";
}

/** 构造 WebDAV Basic Auth 请求头 */
function buildWebdavHeaders(config) {
    const headers = {};
    if (config.user || config.pass) {
        headers["Authorization"] = "Basic " + btoa((config.user || "") + ":" + (config.pass || ""));
    }
    return headers;
}
