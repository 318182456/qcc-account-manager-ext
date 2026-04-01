const RENEWAL_ALARM_NAME = "qcc-session-renewal";
const SYNC_ALARM_NAME = "qcc-auto-sync";
const QCC_INDEX_URL = "https://www.qcc.com/";
const QCC_PROBE_URL = "https://r.qcc.com/monitor/overview";

// ─── 统一日志工具（自动添加 JST 时间戳）───
function _ts() {
    return new Date().toLocaleTimeString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
}
function log(...args) { console.log(`[${_ts()}]`, ...args); }
function logW(...args) { console.warn(`[${_ts()}]`, ...args); }
function logE(...args) { console.error(`[${_ts()}]`, ...args); }

// 确保 alarm 配置与代码一致（先清再建，防止旧间隔残留）
async function ensureAlarms() {
    await chrome.alarms.clearAll();
    chrome.alarms.create(RENEWAL_ALARM_NAME, { periodInMinutes: 25 });
    chrome.alarms.create(SYNC_ALARM_NAME, { periodInMinutes: 30 });
    chrome.alarms.create("qcc-all-session-renewal", { periodInMinutes: 180 });
    log("[保活] alarm 已就绪:", (await chrome.alarms.getAll()).map(a => `${a.name}(${a.periodInMinutes}m)`).join(", "));
}

// 初始化（安装/更新时）
chrome.runtime.onInstalled.addListener(() => {
    ensureAlarms();
});

// Service Worker 启动时恢复 alarm（MV3下Worker会被频繁终止/重启，alarm可能丢失）
chrome.runtime.onStartup.addListener(() => {
    ensureAlarms();
});

// 监听 Popup 发来的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "resetRenewal") {
        log("[保活] 手动触发保活...");
        performRenewalFetch();
    } else if (message.action === "triggerSync") {
        log("[同步] 前端触发立即同步...");
        performAutoSync()
            .then(changed => sendResponse({ success: true, changed }))
            .catch(e => sendResponse({ success: false, error: e.message }));
        return true; // 异步响应
    }
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RENEWAL_ALARM_NAME) {
        log("[保活] 定时保活触发...");
        performRenewalFetch();
    } else if (alarm.name === SYNC_ALARM_NAME) {
        log("[同步] 定时同步触发...");
        performAutoSync();
    } else if (alarm.name === "qcc-all-session-renewal") {
        log("[保活] 全员保活触发...");
        performAllAccountsRenewal();
    }
});

/**
 * 构造伪装成正常浏览的请求头
 */
function buildBrowseHeaders() {
    return {
        "User-Agent": navigator.userAgent,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7",
        "Referer": "https://www.qcc.com/",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache"
    };
}

/**
 * 探针请求：三重判定 Session 是否存活
 *   1) HTTP 状态码 / 重定向检测
 *   2) 响应体内容检测（解析 JSON 或 HTML 是否包含登录态标记）
 *   3) Cookie 存在性检测（核心 Cookie 是否仍存在）
 * 返回 { isAlive, isLoggedOut, responseStatus, detail }
 */
async function probeSession() {
    // ── 第一步：GET 首页，触发服务器 Set-Cookie ──
    const homepageRes = await fetch(QCC_INDEX_URL, {
        method: "GET",
        headers: buildBrowseHeaders(),
        credentials: "include"
    });

    // 首页被重定向到 login
    if (homepageRes.redirected && homepageRes.url.includes("login")) {
        log("[探针] 首页重定向到 login");
        return { isAlive: false, isLoggedOut: true, responseStatus: homepageRes.status, detail: "首页重定向login" };
    }

    // ── 第二步：请求需要登录的 API 探针 ──
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

        // 重定向到登录页
        if (probeRes.redirected && probeRes.url.includes("login")) {
            log("[探针] API 重定向到 login");
            return { isAlive: false, isLoggedOut: true, responseStatus: probeStatus, detail: "API重定向login" };
        }

        // HTTP 状态码异常
        if (probeStatus === 401 || probeStatus === 403 || probeStatus === 425) {
            log(`[探针] API 返回异常状态码: ${probeStatus}`);
            return { isAlive: false, isLoggedOut: false, responseStatus: probeStatus, detail: `HTTP ${probeStatus}` };
        }

        // 读取响应体内容进行判断
        probeBody = await probeRes.text();

        try {
            const json = JSON.parse(probeBody);
            const s = json.status || json.Status;
            const msg = json.message || json.Message || "";

            // 企查查实际返回值：
            //   已注销: {"status":409,"message":"使用该功能需要用户登录"}
            //   正常:   {"status":435,"message":"未知错误","errcode":""}
            if (s === 409 || /登录|login|未授权|expired/i.test(msg)) {
                log(`[探针] API 判定已注销 (status=${s}, message=${msg})`);
                return { isAlive: false, isLoggedOut: true, responseStatus: probeStatus, detail: `API status=${s}` };
            }
            // status=435 或其他非 409 的值，视为 Session 有效
            log(`[探针] API 判定存活 (status=${s}, message=${msg})`);
        } catch (_) {
            // 非 JSON 响应，检查是否是 HTML 登录页
            if (probeBody.includes("login") && (probeBody.includes("password") || probeBody.includes("密码"))) {
                log("[探针] API 返回了 HTML 登录页面");
                return { isAlive: false, isLoggedOut: true, responseStatus: probeStatus, detail: "返回HTML登录页" };
            }
        }
    } catch (e) {
        logW("[探针] API 请求网络异常:", e.message);
        // 网络异常不能确定状态，继续用 Cookie 检测兜底
    }

    // ── 第三步：Cookie 存在性兜底检测 ──
    const cookies = await chrome.cookies.getAll({ domain: "qcc.com" });
    const hasQCCSESSID = cookies.some(c => c.name === "QCCSESSID" && c.value);
    const hasToken = cookies.some(c => c.name === "Token" && c.value);

    if (!hasQCCSESSID && !hasToken) {
        log("[探针] Cookie 兜底检测：QCCSESSID 和 Token 均不存在，判定已注销");
        return { isAlive: false, isLoggedOut: true, responseStatus: probeStatus, detail: "无核心Cookie" };
    }

    log(`[探针] 判定存活 (HTTP=${probeStatus}, SESSID=${hasQCCSESSID}, Token=${hasToken}, body=${probeBody.substring(0, 120)})`);
    return { isAlive: true, isLoggedOut: false, responseStatus: probeStatus, detail: "OK" };
}

/**
 * 当前账号保活：定时触发，维持当前浏览器中活跃 Session 的存活。
 * 
 * 【核心修复】：
 * - 会话存活时 → 抓取最新 Cookie 更新本地存储和过期时间
 * - 会话失效时 → 标记为失效并发送通知
 */
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
            // ✅ 会话存活 → 抓取最新 Cookie 并更新过期时间（这才是保活的核心！）
            const newCookies = await chrome.cookies.getAll({ domain: "qcc.com" });

            let maxExpiry = 0;
            let hasCore = false;
            for (let c of newCookies) {
                if (["QCCSESSID", "Token"].includes(c.name)) {
                    if (c.expirationDate && c.expirationDate > maxExpiry) maxExpiry = c.expirationDate;
                    hasCore = true;
                }
            }
            if (!hasCore || maxExpiry === 0) maxExpiry = (Date.now() / 1000) + 15 * 24 * 3600;

            storage.accounts[currIdx].cookies = newCookies.map(c => ({
                name: c.name, value: c.value, domain: c.domain,
                path: c.path, secure: c.secure, sameSite: c.sameSite,
                expirationDate: c.expirationDate
            }));
            storage.accounts[currIdx].expiry = maxExpiry;
            storage.accounts[currIdx].savedAt = Date.now();
            storage.accounts[currIdx].lastStatus = "正常在线 (已续期)";
            await chrome.storage.local.set({ accounts: storage.accounts });

            log(`[保活] 当前账号「${storage.accounts[currIdx].name}」续期成功，Expiry: ${new Date(maxExpiry * 1000).toLocaleString()}`);

            // 保活成功后立即同步到 WebDAV，让其他设备受益
            performAutoSync().catch(e => logE("[保活] 续期后同步失败:", e));

        } else {
            // ❌ 会话失效 → 标记并通知
            logW(`[保活] 当前账号「${storage.accounts[currIdx].name}」已掉线！Status: ${responseStatus}, LoggedOut: ${isLoggedOut}`);

            storage.accounts[currIdx].lastStatus = isLoggedOut ? "已注销" : `失效 (${responseStatus})`;
            storage.accounts[currIdx].expiry = Math.floor(Date.now() / 1000) - 1;
            await chrome.storage.local.set({ accounts: storage.accounts });

            chrome.notifications.create(`qcc-dead-${Date.now()}`, {
                type: "basic",
                iconUrl: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMDAgMTAwIj48Y2lyY2xlIGN4PSI1MCIgY3k9IjUwIiByPSI1MCIgZmlsbD0iI2Y0NDMzNiIvPjx0ZXh0IHg9IjUwIiB5PSI1NCIgZm9udC1zaXplPSI2MCIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZmlsbD0iI2ZmZiIgZHk9Ii4zZW0iPiE8L3RleHQ+PC9zdmc+",
                title: "企查查当前账号已失效",
                message: `您当前使用的账号【${storage.accounts[currIdx].name}】已被服务器强制登出或掉线，请及时重新登录！`,
                priority: 2
            });
        }

        // 不论存活与否，检查其他账号是否即将过期
        const nowSec = Math.floor(Date.now() / 1000);
        const expiringAccounts = storage.accounts.filter(a => {
            if (a.deleted || a.id === storage.currentAccountId || !a.expiry) return false;
            const daysLeft = (a.expiry - nowSec) / (24 * 3600);
            return daysLeft > 0 && daysLeft < 3;
        });

        if (expiringAccounts.length > 0) {
            const names = expiringAccounts.map(a => a.name).join('、');
            chrome.notifications.create(`qcc-renewal-others-${Date.now()}`, {
                type: "basic",
                iconUrl: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMDAgMTAwIj48Y2lyY2xlIGN4PSI1MCIgY3k9IjUwIiByPSI1MCIgZmlsbD0iI2Y0NDMzNiIvPjx0ZXh0IHg9IjUwIiB5PSI1NCIgZm9udC1zaXplPSI2MCIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZmlsbD0iI2ZmZiIgZHk9Ii4zZW0iPiE8L3RleHQ+PC9zdmc+",
                title: "企查查账号保活提醒",
                message: `有 ${expiringAccounts.length} 个账号（${names}）的Cookie有效期已濒临失效（不足 3 天），请尽快切换保活。`,
                priority: 2
            });
        }
    } catch (e) {
        logE("[保活] 保活请求异常:", e);
    }
}

/**
 * 后台定时双向同步 - 目录模式（manifest.json + uuid.json）
 * 只传输 savedAt 发生变化的账号文件，大幅减少流量
 */
// 获取/初始化当前设备 ID 及名称
async function getOrCreateDeviceInfo() {
    let { deviceId, deviceName } = await chrome.storage.local.get({ deviceId: null, deviceName: null });
    if (!deviceId) {
        deviceId = crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2));
        // 从 UserAgent 中提取简短的系统信息作为默认名称
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

async function performAutoSync() {
    const storage = await chrome.storage.local.get({ webdav: null, accounts: [], autoSync: true, lastUploadAt: {} });
    if (!storage.autoSync) return false;
    const config = storage.webdav;
    if (!config || !config.url) return false;

    const baseUrl = config.url.endsWith("/") ? config.url : config.url + "/";
    const headers = {};
    if (config.user || config.pass) {
        headers["Authorization"] = "Basic " + btoa(config.user + ":" + config.pass);
    }

    const abortFetch = async (url, method, h, body = null) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 60000);
        try {
            const r = await fetch(url, { method, headers: h, body, signal: ctrl.signal });
            clearTimeout(t);
            return r;
        } catch (e) { clearTimeout(t); throw e; }
    };

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

        // 2. 本地 → 云端：推送有变化的账号
        for (const acc of localAccounts) {
            const localTime = acc.savedAt || ((acc.expiry || 0) * 1000);
            const remoteEntry = remoteMap.get(acc.id);
            const remoteTime = remoteEntry ? (remoteEntry.savedAt || 0) : 0;
            const wasUploaded = lastUploadAt[acc.id] || 0;

            if (localTime > wasUploaded && localTime > remoteTime) {
                const cleanLs = {};
                if (acc.localStorage) {
                    for (let k in acc.localStorage) {
                        const v = acc.localStorage[k];
                        if (v && v.length < 5000 && !k.toLowerCase().includes("cache") && !k.toLowerCase().includes("history") && k !== "redux-persist" && !k.includes("AMap")) {
                            cleanLs[k] = v;
                        }
                    }
                }
                const slim = { ...acc, localStorage: cleanLs, cookies: (acc.cookies || []).map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, sameSite: c.sameSite, expirationDate: c.expirationDate })) };

                const h2 = { ...headers, "Content-Type": "application/json" };
                await abortFetch(baseUrl + acc.id + ".json", "PUT", h2, JSON.stringify(slim));
                newLastUpload[acc.id] = localTime;
                const entry = { id: acc.id, name: acc.name, savedAt: localTime, deleted: acc.deleted || false };
                if (manifestIdx.has(acc.id)) { newManifest[manifestIdx.get(acc.id)] = entry; }
                else { newManifest.push(entry); manifestIdx.set(acc.id, newManifest.length - 1); }
                changed = true;
            }
        }

        // 3. 云端 → 本地：拉取云端比本地新的账号
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
            // 更新 manifest（清理30天以上的旧墓碑）
            const thirtyDaysAgo = Date.now() - 30 * 24 * 3600 * 1000;
            const toUpload = newManifest.filter(m => !m.deleted || (m.savedAt || 0) > thirtyDaysAgo);
            const mh = { ...headers, "Content-Type": "application/json" };
            await abortFetch(baseUrl + "manifest.json", "PUT", mh, JSON.stringify(toUpload));
            await chrome.storage.local.set({ accounts: Array.from(localMap.values()), lastUploadAt: newLastUpload });
            log("[同步] 目录模式双向同步完成，有数据更新。");
        }
        // 4. 写入当前设备心跳到 devices.json
        try {
            const { deviceId, deviceName } = await getOrCreateDeviceInfo();
            const devRes = await abortFetch(baseUrl + "devices.json", "GET", headers);
            let deviceList = [];
            if (devRes.ok) {
                const txt = await devRes.text();
                if (txt) deviceList = JSON.parse(txt);
            }
            const nowTs = Date.now();
            const existing = deviceList.find(d => d.id === deviceId);
            if (existing) {
                existing.name = deviceName;
                existing.lastSyncAt = nowTs;
            } else {
                deviceList.push({ id: deviceId, name: deviceName, lastSyncAt: nowTs });
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

// 全员静默轮换保活机制
async function performAllAccountsRenewal() {
    const tabs = await chrome.tabs.query({ url: "*://*.qcc.com/*" });
    const hasQccTabOpen = tabs && tabs.length > 0;

    // 先从 WebDAV 拉取一次最新快照，防止用旧数据覆盖云端
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
        // ════════ 安全模式：企查查页面已打开，不替换Cookie，仅做本地过期检查 ════════
        log("[全员保活] 企查查页面已打开 → 安全模式：仅本地检查过期时间，不替换Cookie");

        const nowSec = Math.floor(Date.now() / 1000);
        const warningAccounts = [];

        for (const acc of allTargets) {
            // 当前使用中的账号由 performRenewalFetch 负责（它不需要换Cookie）
            if (acc.id === storage.currentAccountId) continue;

            // 检查存储的 Cookie 过期时间
            let maxExpiry = 0;
            for (const c of (acc.cookies || [])) {
                if (["QCCSESSID", "Token"].includes(c.name)) {
                    if (c.expirationDate && c.expirationDate > maxExpiry) maxExpiry = c.expirationDate;
                }
            }

            const hoursLeft = maxExpiry > 0 ? (maxExpiry - nowSec) / 3600 : -1;

            if (hoursLeft < 0 || hoursLeft > 24) {
                // 已过期或离过期还很远，跳过
                log(`[全员保活·安全] ${acc.name} → ${hoursLeft < 0 ? "已过期" : `剩余 ${Math.floor(hoursLeft)}h，暂安全`}`);
            } else {
                // 6~24小时内即将过期，发预警
                warningAccounts.push(acc.name);
                logW(`[全员保活·安全] ${acc.name} → 剩余 ${hoursLeft.toFixed(1)}h，即将过期！`);
            }
        }

        if (warningAccounts.length > 0) {
            chrome.notifications.create(`qcc-safe-warn-${Date.now()}`, {
                type: "basic",
                iconUrl: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMDAgMTAwIj48Y2lyY2xlIGN4PSI1MCIgY3k9IjUwIiByPSI1MCIgZmlsbD0iI2Y0NDMzNiIvPjx0ZXh0IHg9IjUwIiB5PSI1NCIgZm9udC1zaXplPSI2MCIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZmlsbD0iI2ZmZiIgZHk9Ii4zZW0iPiE8L3RleHQ+PC9zdmc+",
                title: "账号即将过期（安全模式提醒）",
                message: `${warningAccounts.join("、")} 即将过期，请关闭企查查页面后等待自动续期，或手动切换保活。`,
                priority: 2
            });
        }

        log("[全员保活·安全] 本地检查完成，网络续期将在企查查页面关闭后自动进行。");
        return;
    }

    // ════════ 完整模式：无企查查页面，执行Cookie替换 + 网络续期 ════════
    log("[全员保活] 无企查查活动页面，执行完整网络续期...");

    // 备份当前全局 Cookie
    const currentCookies = await chrome.cookies.getAll({ domain: "qcc.com" });

    for (let i = 0; i < allTargets.length; i++) {
        const acc = allTargets[i];
        log(`[全员保活] (${i + 1}/${allTargets.length}) 正在保活: ${acc.name}`);

        // 清理并注入目标账号的 Cookie
        await clearAllQccDbCookies();
        const setPromises = (acc.cookies || []).map(c => {
            const domain = c.domain.startsWith(".") ? c.domain.substring(1) : c.domain;
            const pfx = c.secure ? "https://" : "http://";
            return chrome.cookies.set({
                url: pfx + domain + c.path,
                name: c.name, value: c.value, domain: c.domain, path: c.path,
                secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
                expirationDate: c.expirationDate, storeId: c.storeId
            }).catch(() => { });
        });
        await Promise.all(setPromises);

        // 发起探针请求（首页 + API 双重探活）
        try {
            const { isAlive, isLoggedOut, responseStatus } = await probeSession();

            // 重新从存储中读取最新状态，防止执行期间其他端同步了删除指令
            const freshStorage = await chrome.storage.local.get({ accounts: [] });
            const freshDbAcc = freshStorage.accounts.find(a => a.id === acc.id);
            
            if (freshDbAcc && !freshDbAcc.deleted) {
                if (isAlive) {
                    freshDbAcc.lastStatus = "正常在线 (后台续期)";

                    // 成功保活后，抓取最新 Cookie 更新过期时间
                    const newCookies = await chrome.cookies.getAll({ domain: "qcc.com" });
                    let maxExpiry = 0;
                    let hasCore = false;
                    for (let c of newCookies) {
                        if (["QCCSESSID", "Token"].includes(c.name)) {
                            if (c.expirationDate && c.expirationDate > maxExpiry) maxExpiry = c.expirationDate;
                            hasCore = true;
                        }
                    }
                    if (!hasCore || maxExpiry === 0) maxExpiry = (Date.now() / 1000) + 15 * 24 * 3600;

                    freshDbAcc.cookies = newCookies.map(c => ({
                        name: c.name, value: c.value, domain: c.domain,
                        path: c.path, secure: c.secure, sameSite: c.sameSite,
                        expirationDate: c.expirationDate
                    }));
                    freshDbAcc.expiry = maxExpiry;
                    freshDbAcc.savedAt = Date.now();

                    // 如果轮换的是当前正在使用的账号，更新用于最后还原的备份 Cookie
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

        // 每个账号间隔 5 秒
        if (i < allTargets.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }

    // 还原最初的 Cookie
    await clearAllQccDbCookies();
    const restorePromises = currentCookies.map(c => {
        const domain = c.domain.startsWith(".") ? c.domain.substring(1) : c.domain;
        const pfx = c.secure ? "https://" : "http://";
        return chrome.cookies.set({
            url: pfx + domain + c.path,
            name: c.name, value: c.value, domain: c.domain, path: c.path,
            secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
            expirationDate: c.expirationDate, storeId: c.storeId
        }).catch(() => { });
    });
    await Promise.all(restorePromises);
    log("[全员保活] 全员静默保活完成，已还原原先全局现场。");

    // 全员保活后推送到云端让其他设备受益
    performAutoSync().catch(e => logE("[全员保活] 保活后同步出错:", e));
}

// 清除所有的 QCC Cookies 辅助函数
async function clearAllQccDbCookies() {
    const cookies = await chrome.cookies.getAll({ domain: "qcc.com" });
    const promises = cookies.map(c => {
        const pfx = c.secure ? "https://" : "http://";
        const domain = c.domain.startsWith(".") ? c.domain.substring(1) : c.domain;
        return chrome.cookies.remove({ url: pfx + domain + c.path, name: c.name });
    });
    await Promise.all(promises);
}
