const RENEWAL_ALARM_NAME = "qcc-session-renewal";
const SYNC_ALARM_NAME = "qcc-auto-sync";
const QCC_INDEX_URL = "https://www.qcc.com/";

// 初始化
chrome.runtime.onInstalled.addListener(() => {
    chrome.alarms.create(RENEWAL_ALARM_NAME, { periodInMinutes: 60 }); // 缩短保活频率为60分钟
    chrome.alarms.create(SYNC_ALARM_NAME, { periodInMinutes: 30 });
    chrome.alarms.create("qcc-all-session-renewal", { periodInMinutes: 240 }); // 全员保活，每4小时触发一次
});

// 监听 Popup 发来的重置续期请求消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "resetRenewal") {
        console.log("手动触发保活请求或重置保活时机...");
        performRenewalFetch();
    }
});

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RENEWAL_ALARM_NAME) {
        console.log("执行定期保活扫描...");
        performRenewalFetch();
    } else if (alarm.name === SYNC_ALARM_NAME) {
        console.log("执行定期 WebDAV 同步扫描...");
        performAutoSync();
    } else if (alarm.name === "qcc-all-session-renewal") {
        console.log("触发全员静默保活...");
        performAllAccountsRenewal();
    }
});

/**
 * 后台悄悄通过 Fetch 请求企查查首页。
 * Chrome 会自动携带对应域名的 Cookie 发送请求，以此来维持 Session 存活，防止长期不操作被提出体外。
 */
async function performRenewalFetch() {
    try {
        const response = await fetch(QCC_INDEX_URL, {
            method: "GET", // 改为 GET 避免被拦截
            headers: {
                "User-Agent": navigator.userAgent,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"
            }
        });

        // 判定本次保活是否因 Session 失效被重定向到 /login 或者直接报错
        let isAlive = true;
        if (response.status === 401 || response.status === 403 || response.status === 425) {
            isAlive = false;
        } else if (response.url && response.url.includes("login")) {
            isAlive = false;
        }

        const storage = await chrome.storage.local.get({ accounts: [], currentAccountId: null });

        if (!isAlive && storage.currentAccountId) {
            console.warn("当前账号保活发现已掉线！");
            const currIdx = storage.accounts.findIndex(a => a.id === storage.currentAccountId);
            if (currIdx !== -1) {
                storage.accounts[currIdx].lastStatus = `失效 (${response.status})`;
                storage.accounts[currIdx].expiry = Math.floor(Date.now() / 1000) - 1; // 强制置为过期
                await chrome.storage.local.set({ accounts: storage.accounts });

                chrome.notifications.create(`qcc-dead-${Date.now()}`, {
                    type: "basic",
                    iconUrl: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMDAgMTAwIj48Y2lyY2xlIGN4PSI1MCIgY3k9IjUwIiByPSI1MCIgZmlsbD0iI2Y0NDMzNiIvPjx0ZXh0IHg9IjUwIiB5PSI1NCIgZm9udC1zaXplPSI2MCIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZmlsbD0iI2ZmZiIgZHk9Ii4zZW0iPiE8L3RleHQ+PC9zdmc+",
                    title: "企查查当前账号已失效",
                    message: `您当前使用的账号【${storage.accounts[currIdx].name}】已被服务器强制登出或掉线，请及时重新登录！`,
                    priority: 2
                });
            }
        } else {
            console.log("当前账号保活请求成功, Status:", response.status);
        }

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
                message: `有 ${expiringAccounts.length} 个账号（${names}）的Cookie有效期已濒临失效（不足 3 天），请尽快点击扩展页面的“重新登录”或进行切换保活。`,
                priority: 2
            });
        }
    } catch (e) {
        console.error("保活请求失败:", e);
    }
}

/**
 * 后台定时双向同步 - 目录模式（manifest.json + uuid.json）
 * 只传输 savedAt 发生变化的账号文件，大幅减少流量
 */
async function performAutoSync() {
    const storage = await chrome.storage.local.get({ webdav: null, accounts: [], autoSync: true, lastUploadAt: {} });
    if (!storage.autoSync) return;
    const config = storage.webdav;
    if (!config || !config.url) return;

    const baseUrl = config.url.endsWith("/") ? config.url : config.url + "/";
    const headers = {};
    if (config.user || config.pass) {
        headers["Authorization"] = "Basic " + btoa(config.user + ":" + config.pass);
    }

    const abortFetch = async (url, method, h, body = null) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 15000);
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
                const slim = { ...acc, cookies: (acc.cookies || []).map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, sameSite: c.sameSite, expirationDate: c.expirationDate })) };
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
            console.log("目录模式双向自动同步完成。");
        }
    } catch (e) {
        console.error("后台自动同步失败:", e);
    }
}

// 全员静默轮换保活机制
async function performAllAccountsRenewal() {
    // 检查是否有打开的企查查网页，如果没有才进行后台轮换，防干扰
    const tabs = await chrome.tabs.query({ url: "*://*.qcc.com/*" });
    if (tabs && tabs.length > 0) {
        console.log("检测到当前有打开的企查查页面，跳过全员保活，防止干扰用户...");
        return;
    }
        
    console.log("当前无企查查活动页面，开始后台静默轮询保活所有备用账号...");
    const storage = await chrome.storage.local.get({ accounts: [], currentAccountId: null });
        const targets = storage.accounts.filter(a => !a.deleted && a.id !== storage.currentAccountId);

        if (targets.length === 0) return;

        // 备份当前全局 Cookie
        const currentCookies = await chrome.cookies.getAll({ domain: "qcc.com" });

        for (let i = 0; i < targets.length; i++) {
            const acc = targets[i];

            // 清理并注入目标账号的 Cookie
            await clearAllQccDbCookies();
            const setPromises = acc.cookies.map(c => {
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

            // 发起 GET 请求
            try {
                const res = await fetch("https://www.qcc.com/", {
                    method: "GET",
                    headers: {
                        "User-Agent": navigator.userAgent,
                        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"
                    }
                });

                let isAlive = true;
                if (res.status === 401 || res.status === 403 || res.status === 425 || (res.url && res.url.includes("login"))) {
                    isAlive = false;
                }

                const dbAcc = storage.accounts.find(a => a.id === acc.id);
                if (dbAcc) {
                    if (isAlive) {
                        dbAcc.lastStatus = "正常在线 (后台更新)";
                    } else {
                        dbAcc.lastStatus = `失效 (${res.status})`;
                        dbAcc.expiry = Math.floor(Date.now() / 1000) - 1;
                    }
                }
                await chrome.storage.local.set({ accounts: storage.accounts });
            } catch (e) {
                console.warn(`静默保活账号 ${acc.name} 失败`, e);
            }

            // 每个账号间隔 8 秒，避免并发风控，同时控制总耗时在 Service Worker 存活期内
            if (i < targets.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 8000));
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
        console.log("全员静默保活完成，已还原原先全局现场。");
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
