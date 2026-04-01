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

// ─── Alarm 管理 ───

async function ensureAlarms() {
    await chrome.alarms.clearAll();
    chrome.alarms.create(RENEWAL_ALARM_NAME, { periodInMinutes: RENEWAL_INTERVAL_MIN });
    chrome.alarms.create(SYNC_ALARM_NAME, { periodInMinutes: SYNC_INTERVAL_MIN });
    chrome.alarms.create(ALL_RENEWAL_ALARM_NAME, { periodInMinutes: ALL_RENEWAL_INTERVAL_MIN });
    log("[保活] alarm 已就绪:", (await chrome.alarms.getAll()).map(a => `${a.name}(${a.periodInMinutes}m)`).join(", "));
}

chrome.runtime.onInstalled.addListener(() => ensureAlarms());
chrome.runtime.onStartup.addListener(() => ensureAlarms());

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
 * 三重判定 Session 是否存活
 * 返回 { isAlive, isLoggedOut, responseStatus, detail }
 */
async function probeSession() {
    // 第一步：GET 首页
    const homepageRes = await fetch(QCC_INDEX_URL, {
        method: "GET",
        headers: buildBrowseHeaders(),
        credentials: "include"
    });

    if (homepageRes.redirected && homepageRes.url.includes("login")) {
        log("[探针] 首页重定向到 login");
        return { isAlive: false, isLoggedOut: true, responseStatus: homepageRes.status, detail: "首页重定向login" };
    }

    // 第二步：API 探针
    let probeStatus = 0;
    let probeBody = "";
    try {
        const probeRes = await fetch(QCC_PROBE_URL, {
            method: "GET",
            headers: {
                ...buildBrowseHeaders(),
                "Accept": "application/json, text/plain, */*",
                "X-Requested-With": "XMLHttpRequest"
            },
            credentials: "include"
        });
        probeStatus = probeRes.status;

        if (probeRes.redirected && probeRes.url.includes("login")) {
            log("[探针] API 重定向到 login");
            return { isAlive: false, isLoggedOut: true, responseStatus: probeStatus, detail: "API重定向login" };
        }

        if (probeStatus === 401 || probeStatus === 403 || probeStatus === 425) {
            log(`[探针] API 返回异常状态码: ${probeStatus}`);
            return { isAlive: false, isLoggedOut: false, responseStatus: probeStatus, detail: `HTTP ${probeStatus}` };
        }

        probeBody = await probeRes.text();

        try {
            const json = JSON.parse(probeBody);
            const s = json.status || json.Status;
            const msg = json.message || json.Message || "";

            if (s === 409 || /登录|login|未授权|expired/i.test(msg)) {
                log(`[探针] API 判定已注销 (status=${s}, message=${msg})`);
                return { isAlive: false, isLoggedOut: true, responseStatus: probeStatus, detail: `API status=${s}` };
            }
            log(`[探针] API 判定存活 (status=${s}, message=${msg})`);
        } catch (_) {
            if (probeBody.includes("login") && (probeBody.includes("password") || probeBody.includes("密码"))) {
                log("[探针] API 返回了 HTML 登录页面");
                return { isAlive: false, isLoggedOut: true, responseStatus: probeStatus, detail: "返回HTML登录页" };
            }
        }
    } catch (e) {
        logW("[探针] API 请求网络异常:", e.message);
    }

    // 第三步：Cookie 兜底检测
    const cookies = await chrome.cookies.getAll({ domain: QCC_DOMAIN });
    const hasQCCSESSID = cookies.some(c => c.name === "QCCSESSID" && c.value);
    const hasToken = cookies.some(c => c.name === "Token" && c.value);

    if (!hasQCCSESSID && !hasToken) {
        log("[探针] Cookie 兜底检测：QCCSESSID 和 Token 均不存在，判定已注销");
        return { isAlive: false, isLoggedOut: true, responseStatus: probeStatus, detail: "无核心Cookie" };
    }

    log(`[探针] 判定存活 (HTTP=${probeStatus}, SESSID=${hasQCCSESSID}, Token=${hasToken}, body=${probeBody.substring(0, 120)})`);
    return { isAlive: true, isLoggedOut: false, responseStatus: probeStatus, detail: "OK" };
}

// ─── 当前账号保活 ───

async function performRenewalFetch() {
    try {
        const { isAlive, isLoggedOut, responseStatus } = await probeSession();
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

// ─── 全员静默保活 ───

async function performAllAccountsRenewal() {
    const tabs = await chrome.tabs.query({ url: QCC_MATCH_PATTERN });
    const hasQccTabOpen = tabs && tabs.length > 0;

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

    if (hasQccTabOpen) {
        // 安全模式：仅本地检查过期时间
        log("[全员保活] 企查查页面已打开 → 安全模式：仅本地检查过期时间，不替换Cookie");

        const nowSec = Math.floor(Date.now() / 1000);
        const warningAccounts = [];

        for (const acc of allTargets) {
            if (acc.id === storage.currentAccountId) continue;
            const { maxExpiry } = calcMaxExpiry(acc.cookies);
            const hoursLeft = maxExpiry > 0 ? (maxExpiry - nowSec) / 3600 : -1;

            if (hoursLeft < 0 || hoursLeft > 24) {
                log(`[全员保活·安全] ${acc.name} → ${hoursLeft < 0 ? "已过期" : `剩余 ${Math.floor(hoursLeft)}h，暂安全`}`);
            } else {
                warningAccounts.push(acc.name);
                logW(`[全员保活·安全] ${acc.name} → 剩余 ${hoursLeft.toFixed(1)}h，即将过期！`);
            }
        }

        if (warningAccounts.length > 0) {
            chrome.notifications.create(`qcc-safe-warn-${Date.now()}`, {
                type: "basic",
                iconUrl: NOTIFICATION_ICON_URL,
                title: "账号即将过期（安全模式提醒）",
                message: `${warningAccounts.join("、")} 即将过期，请关闭企查查页面后等待自动续期，或手动切换保活。`,
                priority: 2
            });
        }

        log("[全员保活·安全] 本地检查完成，网络续期将在企查查页面关闭后自动进行。");
        return;
    }

    // 完整模式：Cookie 替换 + 网络续期
    log("[全员保活] 无企查查活动页面，执行完整网络续期...");

    const currentCookies = await chrome.cookies.getAll({ domain: QCC_DOMAIN });

    for (let i = 0; i < allTargets.length; i++) {
        const acc = allTargets[i];
        log(`[全员保活] (${i + 1}/${allTargets.length}) 正在保活: ${acc.name}`);

        await clearAllQccCookies();
        await injectCookies(acc.cookies);

        try {
            const { isAlive, isLoggedOut, responseStatus } = await probeSession();
            const freshStorage = await chrome.storage.local.get({ accounts: [] });
            const freshDbAcc = freshStorage.accounts.find(a => a.id === acc.id);

            if (freshDbAcc && !freshDbAcc.deleted) {
                if (isAlive) {
                    freshDbAcc.lastStatus = "正常在线 (后台续期)";
                    const newCookies = await chrome.cookies.getAll({ domain: QCC_DOMAIN });
                    const { maxExpiry: rawExpiry, hasCore } = calcMaxExpiry(newCookies);
                    const maxExpiry = ensureExpiry(rawExpiry, hasCore);

                    freshDbAcc.cookies = newCookies.map(slimCookie);
                    freshDbAcc.expiry = maxExpiry;
                    freshDbAcc.savedAt = Date.now();

                    // 如果是当前使用的账号，更新备份
                    if (acc.id === storage.currentAccountId) {
                        currentCookies.length = 0;
                        currentCookies.push(...newCookies);
                    }
                    log(`[全员保活] ${acc.name} → 续期成功，Expiry: ${new Date(maxExpiry * 1000).toLocaleString()}`);
                } else {
                    freshDbAcc.lastStatus = isLoggedOut ? "已注销" : `失效 (${responseStatus})`;
                    freshDbAcc.expiry = Math.floor(Date.now() / 1000) - 1;
                    logW(`[全员保活] ${acc.name} → 已失效 (${isLoggedOut ? '已注销' : responseStatus})`);
                }
                await chrome.storage.local.set({ accounts: freshStorage.accounts });
            }
        } catch (e) {
            logW(`[全员保活] ${acc.name} 保活异常:`, e);
        }

        // 每个账号间隔
        if (i < allTargets.length - 1) {
            await new Promise(resolve => setTimeout(resolve, RENEWAL_INTERVAL_SEC));
        }
    }

    // 还原 Cookie
    await clearAllQccCookies();
    await injectCookies(currentCookies);
    log("[全员保活] 全员静默保活完成，已还原原先全局现场。");

    performAutoSync().catch(e => logE("[全员保活] 保活后同步出错:", e));
}
