/**
 * background.js — 企查查多账号管理扩展 Service Worker
 * 依赖: shared/constants.js, shared/utils.js（通过 importScripts 加载）
 */
importScripts("shared/constants.js", "shared/utils.js");

// ─── 统一日志工具（自动添加时间戳）───
function _ts() {
    return new Date().toLocaleTimeString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
}
function log(...args) { console.log(`[${_ts()}]`, ...args); }
function logW(...args) { console.warn(`[${_ts()}]`, ...args); }
function logE(...args) { console.error(`[${_ts()}]`, ...args); }

/**
 * incognito: "split" 会让 Service Worker 在普通和隐身上下文各跑一份实例。
 * 保活/同步只应由普通实例执行，否则请求和存储写入会翻倍。
 */
const IS_INCOGNITO_CONTEXT = chrome.extension.inIncognitoContext === true;

// ─── Alarm 管理 ───

/**
 * Alarm 排期表：每个 alarm 用「基础周期 ± 抖动」的一次性排期，
 * 触发后重新排期。固定 periodInMinutes 会形成可识别的机器人心跳节奏。
 */
const ALARM_SCHEDULE = {
    [RENEWAL_ALARM_NAME]: { base: RENEWAL_BASE_MIN, jit: RENEWAL_JITTER_MIN },
    [SYNC_ALARM_NAME]: { base: SYNC_BASE_MIN, jit: SYNC_JITTER_MIN },
    [ALL_RENEWAL_ALARM_NAME]: { base: ALL_RENEWAL_BASE_MIN, jit: ALL_RENEWAL_JITTER_MIN }
};

/** 按抖动后的延迟重新排期单个 alarm */
function scheduleAlarm(name) {
    const cfg = ALARM_SCHEDULE[name];
    if (!cfg) return;
    const delay = jitter(cfg.base, cfg.jit);
    chrome.alarms.create(name, { delayInMinutes: delay });
    log(`[排期] ${name} → ${delay.toFixed(1)} 分钟后`);
}

/**
 * 补齐缺失的 alarm
 *
 * 用的是一次性 alarm（为了抖动），触发后即失效。若 Service Worker 在
 * 重新排期前被终止，该 alarm 会永久丢失，保活将静默停止。因此每次
 * Worker 唤醒都检查一遍，缺哪个补哪个。
 * @param {boolean} [reset] 为 true 时清空后全部重排
 */
async function ensureAlarms(reset = false) {
    if (IS_INCOGNITO_CONTEXT) {
        log("[排期] 隐身上下文实例，不注册 alarm");
        return;
    }

    if (reset) await chrome.alarms.clearAll();

    const existing = new Set((await chrome.alarms.getAll()).map(a => a.name));
    for (const name of Object.keys(ALARM_SCHEDULE)) {
        if (!existing.has(name)) scheduleAlarm(name);
    }
}

chrome.runtime.onInstalled.addListener(() => ensureAlarms(true));
chrome.runtime.onStartup.addListener(() => ensureAlarms(true));

// Worker 每次冷启动都自愈一次，防止一次性 alarm 丢失后保活永久停摆
ensureAlarms();

// ─── 消息监听 ───

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "resetRenewal") {
        log("[保活] 手动触发保活...");
        performRenewalFetch();
    } else if (message.action === "triggerSync") {
        log("[同步] 前端触发立即同步...");
        performAutoSync()
            .then(changed => sendResponse({ success: true, changed }))
            .catch(e => sendResponse({ success: false, error: e.message }));
        return true;
    }
});

chrome.alarms.onAlarm.addListener((alarm) => {
    // alarm 事件会广播到两个实例；隐身实例直接忽略，避免任务重复执行
    if (IS_INCOGNITO_CONTEXT) return;

    // 一次性 alarm 触发即失效，先重新排期再执行任务
    scheduleAlarm(alarm.name);

    if (alarm.name === RENEWAL_ALARM_NAME) {
        log("[保活] 定时保活触发...");
        performRenewalFetch();
    } else if (alarm.name === SYNC_ALARM_NAME) {
        log("[同步] 定时同步触发...");
        performAutoSync();
    } else if (alarm.name === ALL_RENEWAL_ALARM_NAME) {
        log("[保活] 全员保活触发...");
        performAllAccountsRenewal();
    }
});

// ─── 伪装浏览请求头 ───

function buildBrowseHeaders() {
    return {
        "User-Agent": navigator.userAgent,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7",
        "Referer": QCC_INDEX_URL,
        "Cache-Control": "no-cache",
        "Pragma": "no-cache"
    };
}

// ─── 探针请求 ───

/**
 * 判定 Session 是否存活
 *
 * 只请求首页（一个请求），并从响应体推断登录态；仅在首页请求彻底失败时
 * 才回落到 Cookie 检测。原实现串行打首页 + 业务 API 两个请求，业务接口的
 * 风控权重远高于首页，且请求数翻倍。
 *
 * @param {string} [storeId] Cookie 容器 ID，仅用于兜底检测的读取范围
 * @returns {{ isAlive, isLoggedOut, responseStatus, detail }}
 */
async function probeSession(storeId) {
    let status = 0;
    let body = "";

    try {
        const res = await fetch(QCC_PROBE_URL, {
            method: "GET",
            headers: buildBrowseHeaders(),
            credentials: "include"
        });
        status = res.status;

        if (res.redirected && res.url.includes("login")) {
            log("[探针] 首页重定向到 login");
            return { isAlive: false, isLoggedOut: true, responseStatus: status, detail: "重定向login" };
        }

        if (status === 401 || status === 403 || status === 425) {
            log(`[探针] 异常状态码: ${status}`);
            return { isAlive: false, isLoggedOut: false, responseStatus: status, detail: `HTTP ${status}` };
        }

        body = await res.text();

        // 首页返回登录表单 → 已注销
        if (/name=["']?password|输入密码|请登录/i.test(body)) {
            log("[探针] 首页返回登录表单");
            return { isAlive: false, isLoggedOut: true, responseStatus: status, detail: "返回登录页" };
        }
    } catch (e) {
        logW("[探针] 首页请求网络异常:", e.message);
    }

    // Cookie 兜底：网络不可用或响应无法判定时，至少确认凭证是否还在
    const query = { domain: QCC_DOMAIN };
    if (storeId) query.storeId = storeId;
    const cookies = await chrome.cookies.getAll(query);
    const hasCore = CORE_COOKIE_NAMES.some(n => cookies.some(c => c.name === n && c.value));

    if (!hasCore) {
        log("[探针] Cookie 兜底：核心 Cookie 均不存在，判定已注销");
        return { isAlive: false, isLoggedOut: true, responseStatus: status, detail: "无核心Cookie" };
    }

    log(`[探针] 判定存活 (HTTP=${status}, core=${hasCore})`);
    return { isAlive: true, isLoggedOut: false, responseStatus: status, detail: "OK" };
}

// ─── 当前账号保活 ───

async function performRenewalFetch() {
    try {
        const storage = await chrome.storage.local.get({ accounts: [], currentAccountId: null });

        if (!storage.currentAccountId) {
            log("[保活] 没有当前激活账号，跳过");
            return;
        }

        const currIdx = storage.accounts.findIndex(a => a.id === storage.currentAccountId);
        if (currIdx === -1) {
            log("[保活] 找不到当前账号记录，跳过");
            return;
        }

        // 用户正在浏览企查查时，页面自身的请求已在续期，无需再发探针
        const openTabs = await chrome.tabs.query({ url: QCC_MATCH_PATTERN });
        const pageActive = openTabs.length > 0;

        let isAlive, isLoggedOut, responseStatus;
        if (pageActive) {
            const cookies = await chrome.cookies.getAll({ domain: QCC_DOMAIN });
            isAlive = CORE_COOKIE_NAMES.some(n => cookies.some(c => c.name === n && c.value));
            isLoggedOut = !isAlive;
            responseStatus = 0;
            log(`[保活] 企查查页面活跃 → 免请求模式，凭证${isAlive ? "存在" : "缺失"}`);
        } else {
            ({ isAlive, isLoggedOut, responseStatus } = await probeSession());
        }

        if (isAlive) {
            // 抓取最新 Cookie 并更新过期时间
            const newCookies = await chrome.cookies.getAll({ domain: QCC_DOMAIN });
            const { maxExpiry: rawExpiry, hasCore } = calcMaxExpiry(newCookies);
            const maxExpiry = ensureExpiry(rawExpiry, hasCore);

            storage.accounts[currIdx].cookies = newCookies.map(slimCookie);
            storage.accounts[currIdx].expiry = maxExpiry;
            storage.accounts[currIdx].savedAt = Date.now();
            storage.accounts[currIdx].lastStatus = "正常在线 (已续期)";
            await chrome.storage.local.set({ accounts: storage.accounts });

            log(`[保活] 当前账号「${storage.accounts[currIdx].name}」续期成功，Expiry: ${new Date(maxExpiry * 1000).toLocaleString()}`);
            performAutoSync().catch(e => logE("[保活] 续期后同步失败:", e));

        } else {
            logW(`[保活] 当前账号「${storage.accounts[currIdx].name}」已掉线！Status: ${responseStatus}, LoggedOut: ${isLoggedOut}`);
            storage.accounts[currIdx].lastStatus = isLoggedOut ? "已注销" : `失效 (${responseStatus})`;
            storage.accounts[currIdx].expiry = Math.floor(Date.now() / 1000) - 1;
            await chrome.storage.local.set({ accounts: storage.accounts });

            chrome.notifications.create(`qcc-dead-${Date.now()}`, {
                type: "basic",
                iconUrl: NOTIFICATION_ICON_URL,
                title: "企查查当前账号已失效",
                message: `您当前使用的账号【${storage.accounts[currIdx].name}】已被服务器强制登出或掉线，请及时重新登录！`,
                priority: 2
            });
        }

        // 检查其他账号是否即将过期
        const nowSec = Math.floor(Date.now() / 1000);
        const expiringAccounts = storage.accounts.filter(a => {
            if (a.deleted || a.id === storage.currentAccountId || !a.expiry) return false;
            const daysLeft = (a.expiry - nowSec) / ONE_DAY_SEC;
            return daysLeft > 0 && daysLeft < EXPIRY_WARNING_DAYS;
        });

        if (expiringAccounts.length > 0) {
            const names = expiringAccounts.map(a => a.name).join("、");
            chrome.notifications.create(`qcc-renewal-others-${Date.now()}`, {
                type: "basic",
                iconUrl: NOTIFICATION_ICON_URL,
                title: "企查查账号保活提醒",
                message: `有 ${expiringAccounts.length} 个账号（${names}）的Cookie有效期已濒临失效（不足 ${EXPIRY_WARNING_DAYS} 天），请尽快切换保活。`,
                priority: 2
            });
        }
    } catch (e) {
        logE("[保活] 保活请求异常:", e);
    }
}

// ─── WebDAV 同步 ───

async function getOrCreateDeviceInfo() {
    let { deviceId, deviceName } = await chrome.storage.local.get({ deviceId: null, deviceName: null });
    if (!deviceId) {
        deviceId = crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2));
        const ua = navigator.userAgent;
        const winMatch = ua.match(/Windows NT (\d+\.\d+)/);
        const macMatch = ua.match(/Mac OS X ([\d_]+)/);
        if (winMatch) deviceName = `Windows PC (${winMatch[1]})`;
        else if (macMatch) deviceName = `Mac (${macMatch[1].replace(/_/g, '.')})`;
        else deviceName = `Browser`;
        await chrome.storage.local.set({ deviceId, deviceName });
    }
    return { deviceId, deviceName };
}

/** 带超时的 fetch 封装 */
async function abortFetch(url, method, headers, body = null) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), WEBDAV_TIMEOUT_MS);
    try {
        const r = await fetch(url, { method, headers, body, signal: ctrl.signal });
        clearTimeout(t);
        return r;
    } catch (e) { clearTimeout(t); throw e; }
}

async function performAutoSync() {
    const storage = await chrome.storage.local.get({ webdav: null, accounts: [], autoSync: true, lastUploadAt: {} });
    if (!storage.autoSync) return false;
    const config = storage.webdav;
    if (!config || !config.url) return false;

    const baseUrl = normalizeBaseUrl(config.url);
    const headers = buildWebdavHeaders(config);

    try {
        // 1. 读远端 manifest
        const mRes = await abortFetch(baseUrl + "manifest.json", "GET", headers);
        let remoteManifest = [];
        if (mRes.ok) {
            const txt = await mRes.text();
            if (txt) remoteManifest = JSON.parse(txt);
        }
        const remoteMap = new Map(remoteManifest.map(m => [m.id, m]));

        let localAccounts = storage.accounts;
        const localMap = new Map(localAccounts.map(a => [a.id, a]));
        const lastUploadAt = storage.lastUploadAt || {};
        const newLastUpload = { ...lastUploadAt };
        const newManifest = [...remoteManifest];
        const manifestIdx = new Map(newManifest.map((m, i) => [m.id, i]));
        let changed = false;

        // 2. 本地 → 云端
        for (const acc of localAccounts) {
            const localTime = acc.savedAt || ((acc.expiry || 0) * 1000);
            const remoteEntry = remoteMap.get(acc.id);
            const remoteTime = remoteEntry ? (remoteEntry.savedAt || 0) : 0;
            const wasUploaded = lastUploadAt[acc.id] || 0;

            if (localTime > wasUploaded && localTime > remoteTime) {
                const slim = {
                    ...acc,
                    localStorage: filterLocalStorage(acc.localStorage),
                    cookies: (acc.cookies || []).map(slimCookie)
                };

                const h2 = { ...headers, "Content-Type": "application/json" };
                await abortFetch(baseUrl + acc.id + ".json", "PUT", h2, JSON.stringify(slim));
                newLastUpload[acc.id] = localTime;
                const entry = { id: acc.id, name: acc.name, savedAt: localTime, deleted: acc.deleted || false };
                if (manifestIdx.has(acc.id)) { newManifest[manifestIdx.get(acc.id)] = entry; }
                else { newManifest.push(entry); manifestIdx.set(acc.id, newManifest.length - 1); }
                changed = true;
            }
        }

        // 3. 云端 → 本地
        for (const rEntry of remoteManifest) {
            const localAcc = localMap.get(rEntry.id);
            const localTime = localAcc ? (localAcc.savedAt || ((localAcc.expiry || 0) * 1000)) : 0;
            const remoteTime = rEntry.savedAt || 0;

            if (remoteTime > localTime) {
                const r = await abortFetch(baseUrl + rEntry.id + ".json", "GET", headers);
                if (r.ok) {
                    const remoteAcc = JSON.parse(await r.text());
                    localMap.set(rEntry.id, remoteAcc);
                    changed = true;
                }
            }
        }

        if (changed) {
            const toUpload = newManifest.filter(m => !m.deleted || (m.savedAt || 0) > Date.now() - TOMBSTONE_TTL_MS);
            const mh = { ...headers, "Content-Type": "application/json" };
            await abortFetch(baseUrl + "manifest.json", "PUT", mh, JSON.stringify(toUpload));
            await chrome.storage.local.set({ accounts: Array.from(localMap.values()), lastUploadAt: newLastUpload });
            log("[同步] 目录模式双向同步完成，有数据更新。");
        }

        // 4. 设备心跳
        try {
            const { deviceId, deviceName } = await getOrCreateDeviceInfo();
            const devRes = await abortFetch(baseUrl + "devices.json", "GET", headers);
            let deviceList = [];
            if (devRes.ok) {
                const txt = await devRes.text();
                if (txt) deviceList = JSON.parse(txt);
            }
            const nowTs = Date.now();
            const extVersion = chrome.runtime.getManifest().version;
            const existing = deviceList.find(d => d.id === deviceId);
            if (existing) {
                existing.name = deviceName;
                existing.lastSyncAt = nowTs;
                existing.version = extVersion;
            } else {
                deviceList.push({ id: deviceId, name: deviceName, lastSyncAt: nowTs, version: extVersion });
            }
            const dh = { ...headers, "Content-Type": "application/json" };
            await abortFetch(baseUrl + "devices.json", "PUT", dh, JSON.stringify(deviceList));
        } catch (e) {
            logW("[同步] 设备心跳写入失败:", e);
        }

        return changed;
    } catch (e) {
        logE("[同步] 后台自动同步失败:", e);
        return false;
    }
}

// ─── 隐身容器隔离 ───

/**
 * 定位隐身 Cookie 容器的 storeId
 *
 * 隐身容器只在存在隐身窗口时才出现，因此需要先开一个隐身窗口。
 * @returns {Promise<{storeId: string, windowId: number}|null>} 不可用时返回 null
 */
async function acquireIncognitoStore() {
    if (!chrome.extension.isAllowedIncognitoAccess) return null;
    const allowed = await chrome.extension.isAllowedIncognitoAccess();
    if (!allowed) {
        logW("[隔离] 扩展未获得隐身模式访问权限，无法隔离保活");
        return null;
    }

    // 用户已有隐身窗口时不新建，避免污染其隐身会话
    const wins = await chrome.windows.getAll({});
    if (wins.some(w => w.incognito)) {
        logW("[隔离] 检测到用户已开启隐身窗口，本轮跳过隔离保活");
        return null;
    }

    // about:blank 起窗，避免额外产生一次企查查请求
    let win;
    try {
        win = await chrome.windows.create({
            url: "about:blank",
            incognito: true,
            state: "minimized"
        });
    } catch (e) {
        logW("[隔离] 创建隐身窗口失败:", e.message);
        return null;
    }

    const stores = await chrome.cookies.getAllCookieStores();
    const incogStore = stores.find(s => s.id !== COOKIE_STORE_NORMAL);

    if (!incogStore) {
        logW("[隔离] 未能定位隐身 Cookie 容器");
        await chrome.windows.remove(win.id).catch(() => { });
        return null;
    }

    log(`[隔离] 隐身容器就绪: storeId=${incogStore.id}, windowId=${win.id}`);
    return { storeId: incogStore.id, windowId: win.id };
}

/** 在指定窗口打开标签页、等其加载完成，然后关闭 */
async function visitInWindow(windowId, url) {
    const tab = await chrome.tabs.create({ url, windowId, active: false });

    await new Promise(resolve => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(onUpdated);
            chrome.tabs.onRemoved.removeListener(onRemoved);
            resolve();
        };

        const timer = setTimeout(finish, TAB_LOAD_TIMEOUT_MS);
        const onUpdated = (tabId, info) => {
            if (tabId === tab.id && info.status === "complete") finish();
        };
        // 标签页被意外关闭时也要退出等待，否则会一直挂到超时
        const onRemoved = (tabId) => { if (tabId === tab.id) finish(); };

        chrome.tabs.onUpdated.addListener(onUpdated);
        chrome.tabs.onRemoved.addListener(onRemoved);
    });

    // 页面加载完成后仍有异步 XHR 会刷新 Cookie，静置一小段时间再读取
    await sleep(TAB_SETTLE_MS);
    await chrome.tabs.remove(tab.id).catch(() => { });
}

/**
 * 在隐身容器内为单个账号续期，全程不触碰普通容器
 * @returns {Promise<{isAlive, isLoggedOut, responseStatus, cookies}>}
 */
async function renewInIsolation(acc, ctx) {
    await clearAllQccCookies(ctx.storeId);
    await injectCookies(acc.cookies, ctx.storeId);

    // 由隐身标签页自己带着隔离 Cookie 发真实请求（fetch 无法指定容器）
    await visitInWindow(ctx.windowId, QCC_INDEX_URL);

    const cookies = await chrome.cookies.getAll({ domain: QCC_DOMAIN, storeId: ctx.storeId });
    const hasCore = CORE_COOKIE_NAMES.some(n => cookies.some(c => c.name === n && c.value));

    return {
        isAlive: hasCore,
        isLoggedOut: !hasCore,
        responseStatus: 0,
        cookies
    };
}

// ─── 全员静默保活 ───

/** 仅本地检查过期时间并提醒，不发任何请求 */
async function notifyExpiringAccounts(targets, currentAccountId) {
    const nowSec = Math.floor(Date.now() / 1000);
    const warning = [];

    for (const acc of targets) {
        if (acc.id === currentAccountId) continue;
        const { maxExpiry } = calcMaxExpiry(acc.cookies);
        const hoursLeft = maxExpiry > 0 ? (maxExpiry - nowSec) / 3600 : -1;

        if (hoursLeft >= 0 && hoursLeft <= 24) {
            warning.push(acc.name);
            logW(`[保活检查] ${acc.name} → 剩余 ${hoursLeft.toFixed(1)}h，即将过期！`);
        }
    }

    if (warning.length > 0) {
        chrome.notifications.create(`qcc-expiring-${Date.now()}`, {
            type: "basic",
            iconUrl: NOTIFICATION_ICON_URL,
            title: "账号即将过期",
            message: `${warning.join("、")} 即将过期，请手动切换登录以续期。`,
            priority: 2
        });
    }
}

/**
 * 全员静默保活
 *
 * 在隐身 Cookie 容器内逐个续期，普通容器（用户当前身份）全程不被触碰。
 * 原实现在全局容器里反复清空/注入 Cookie，导致：
 *   1. 循环期间用户打开企查查会带上别人的 Cookie；
 *   2. 同一浏览器指纹短时间内切换多个身份，触发服务器风控把账号全部踢下线；
 *   3. 还原时用的是循环开始前的旧快照，可能覆盖掉已轮换的有效 Cookie。
 */
async function performAllAccountsRenewal() {
    // 先同步最新快照
    try {
        await performAutoSync();
        log("[全员保活] 启动前云端同步完成。");
    } catch (e) {
        logW("[全员保活] 启动前同步失败，将继续执行:", e);
    }

    const storage = await chrome.storage.local.get({ accounts: [], currentAccountId: null });
    const allTargets = storage.accounts.filter(a => !a.deleted);
    if (allTargets.length === 0) return;

    // 只续期临近过期的账号：有效期还长的账号无需打扰服务器
    const nowSec = Math.floor(Date.now() / 1000);
    const targets = allTargets.filter(acc => {
        if (acc.id === storage.currentAccountId) return false; // 当前账号由 performRenewalFetch 负责
        const { maxExpiry } = calcMaxExpiry(acc.cookies);
        if (maxExpiry <= 0) return false;
        const hoursLeft = (maxExpiry - nowSec) / 3600;
        return hoursLeft > 0 && hoursLeft < RENEWAL_THRESHOLD_HOURS;
    });

    if (targets.length === 0) {
        log(`[全员保活] 无账号进入 ${RENEWAL_THRESHOLD_HOURS}h 续期窗口，跳过网络续期。`);
        await notifyExpiringAccounts(allTargets, storage.currentAccountId);
        return;
    }

    const ctx = await acquireIncognitoStore();
    if (!ctx) {
        // 降级：不做 Cookie 轮转，只提醒。宁可让账号自然过期，也不冒掉线风险。
        logW("[全员保活] 隐身容器不可用 → 降级为仅提醒模式（不轮转 Cookie）");
        await notifyExpiringAccounts(allTargets, storage.currentAccountId);
        return;
    }

    log(`[全员保活] 隔离模式启动，待续期 ${targets.length} 个账号`);

    try {
        for (let i = 0; i < targets.length; i++) {
            const acc = targets[i];
            log(`[全员保活] (${i + 1}/${targets.length}) 正在保活: ${acc.name}`);

            try {
                const { isAlive, isLoggedOut, responseStatus, cookies } = await renewInIsolation(acc, ctx);

                // 重新读取存储：保活耗时较长，期间可能已有其他改动
                const fresh = await chrome.storage.local.get({ accounts: [] });
                const dbAcc = fresh.accounts.find(a => a.id === acc.id);
                if (!dbAcc || dbAcc.deleted) continue;

                if (isAlive) {
                    const { maxExpiry: rawExpiry, hasCore } = calcMaxExpiry(cookies);
                    dbAcc.cookies = cookies.map(slimCookie);
                    dbAcc.expiry = ensureExpiry(rawExpiry, hasCore);
                    dbAcc.savedAt = Date.now();
                    dbAcc.lastStatus = "正常在线 (隔离续期)";
                    log(`[全员保活] ${acc.name} → 续期成功，Expiry: ${new Date(dbAcc.expiry * 1000).toLocaleString()}`);
                } else {
                    dbAcc.lastStatus = isLoggedOut ? "已注销" : `失效 (${responseStatus})`;
                    dbAcc.expiry = Math.floor(Date.now() / 1000) - 1;
                    logW(`[全员保活] ${acc.name} → 已失效`);
                }
                await chrome.storage.local.set({ accounts: fresh.accounts });
            } catch (e) {
                logW(`[全员保活] ${acc.name} 保活异常:`, e);
            }

            // 账号之间留足带抖动的间隔，避免密集切换身份
            if (i < targets.length - 1) {
                const gap = jitter(RENEWAL_GAP_BASE_MS, RENEWAL_GAP_JITTER_MS);
                log(`[全员保活] 等待 ${(gap / 1000).toFixed(1)}s 后继续...`);
                await sleep(gap);
            }
        }
    } finally {
        // 清空隐身容器痕迹并关窗；普通容器从未被修改，无需还原
        await clearAllQccCookies(ctx.storeId).catch(() => { });
        await chrome.windows.remove(ctx.windowId).catch(() => { });
        log("[全员保活] 隔离环境已清理，用户当前身份全程未受影响。");
    }

    performAutoSync().catch(e => logE("[全员保活] 保活后同步出错:", e));
}
