const RENEWAL_ALARM_NAME = "qcc-session-renewal";
const SYNC_ALARM_NAME = "qcc-auto-sync";
const QCC_INDEX_URL = "https://www.qcc.com/";

// 初始化
chrome.runtime.onInstalled.addListener(() => {
    chrome.alarms.create(RENEWAL_ALARM_NAME, { periodInMinutes: 120 });
    chrome.alarms.create(SYNC_ALARM_NAME, { periodInMinutes: 30 });
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
    }
});

/**
 * 后台悄悄通过 Fetch 请求企查查首页。
 * Chrome 会自动携带对应域名的 Cookie 发送请求，以此来维持 Session 存活，防止长期不操作被提出体外。
 */
async function performRenewalFetch() {
    try {
        // 由于 fetch qcc.com 只用到当前浏览器状态下处于激活状态的 qcc cookies
        // 如果想针对每一个保存的账号做到保活，过程极其复杂(需要循环切换cookie做fetch再切回来)
        // 且频繁更换全局Cookie会导致用户正在使用的会话被覆盖。
        // 因此目前的机制是：仅保活浏览器【当前正在使用】的这个 qcc.com 会话。
        const response = await fetch(QCC_INDEX_URL, {
            method: "HEAD",
            headers: {
                "User-Agent": navigator.userAgent
            }
        });
        console.log("保活请求成功, Status:", response.status);

        // 新增：检查列表中除当前账号外的其他账号，如果有剩余时间不到 30 天的，则触发通知提醒切换保活
        const storage = await chrome.storage.local.get({ accounts: [], currentAccountId: null });
        const nowSec = Math.floor(Date.now() / 1000);

        const expiringAccounts = storage.accounts.filter(a => {
            if (a.deleted || a.id === storage.currentAccountId || !a.expiry) return false;
            const daysLeft = (a.expiry - nowSec) / (24 * 3600);
            return daysLeft < 30;
        });

        if (expiringAccounts.length > 0) {
            const names = expiringAccounts.map(a => a.name).join('、');
            chrome.notifications.create(`qcc-renewal-others-${Date.now()}`, {
                type: "basic",
                iconUrl: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMDAgMTAwIj48Y2lyY2xlIGN4PSI1MCIgY3k9IjUwIiByPSI1MCIgZmlsbD0iI2Y0NDMzNiIvPjx0ZXh0IHg9IjUwIiB5PSI1NCIgZm9udC1zaXplPSI2MCIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZmlsbD0iI2ZmZiIgZHk9Ii4zZW0iPiE8L3RleHQ+PC9zdmc+",
                title: "企查查账号保活提醒",
                message: `有 ${expiringAccounts.length} 个账号（${names}）的Cookie有效期已不足30天，请尽快切换至这些账号以进行保活续期。`,
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


