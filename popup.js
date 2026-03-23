const QCC_URL = "https://www.qcc.com";
const QCC_DOMAIN = "qcc.com";

// DOM 元件
const accNameInput = document.getElementById("accNameInput");
const addCurrentBtn = document.getElementById("addCurrentBtn");
const saveBox = document.getElementById("saveBox");
const clearAndAddNewBtn = document.getElementById("clearAndAddNewBtn");
const accountStatusText = document.getElementById("accountStatusText");
const currentAccountText = document.getElementById("currentAccountText");
const accountList = document.getElementById("accountList");
const checkAllBtn = document.getElementById("checkAllBtn");
const emptyState = document.getElementById("emptyState");
const downloadSyncBtn = document.getElementById("downloadSyncBtn");
const uploadSyncBtn = document.getElementById("uploadSyncBtn");
const openOptionsBtn = document.getElementById("openOptionsBtn");

// 格式化过期时间
function formatExpiry(timestampSec) {
    if (!timestampSec) return "未知";
    const date = new Date(timestampSec * 1000);
    return date.toLocaleString();
}

// 检查是否在企查查页面
async function getActiveQccTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url.includes(QCC_DOMAIN)) {
        return null;
    }
    return tab;
}

// 从当前页面获取 LocalStorage
async function getQccLocalStorage(tabId) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => JSON.stringify(window.localStorage)
        });
        return JSON.parse(results[0].result);
    } catch (e) {
        console.error("获取 LocalStorage 失败", e);
        return {};
    }
}

// 向页面注入目标 LocalStorage
async function setQccLocalStorage(tabId, lsData) {
    await chrome.scripting.executeScript({
        target: { tabId },
        func: (dataStr) => {
            window.localStorage.clear();
            const data = JSON.parse(dataStr);
            for (let key in data) {
                window.localStorage.setItem(key, data[key]);
            }
        },
        args: [JSON.stringify(lsData)]
    });
}

// 清除所有的 QCC Cookies
async function clearAllQccCookies() {
    const cookies = await chrome.cookies.getAll({ domain: QCC_DOMAIN });
    const promises = cookies.map(c => {
        const pfx = c.secure ? "https://" : "http://";
        const domain = c.domain.startsWith(".") ? c.domain.substring(1) : c.domain;
        const url = pfx + domain + c.path;
        return chrome.cookies.remove({ url: url, name: c.name });
    });
    await Promise.all(promises);
}

// 保存当前账号
addCurrentBtn.addEventListener("click", async () => {
    const name = accNameInput.value.trim();
    if (!name) {
        alert("请输入账号备注");
        return;
    }

    const tab = await getActiveQccTab();
    if (!tab) {
        alert("请在企查查页面 (qcc.com) 且加载完毕后使用此功能！");
        return;
    }

    addCurrentBtn.textContent = "保存中...";
    addCurrentBtn.disabled = true;

    try {
        // 读取 Cookies
        const cookies = await chrome.cookies.getAll({ domain: QCC_DOMAIN });

        // 读取 LocalStorage
        const lsData = await getQccLocalStorage(tab.id);

        // 获取最大有效期作为账号大致过期时间
        let maxExpiry = 0;
        for (let c of cookies) {
            if (c.expirationDate && c.expirationDate > maxExpiry) {
                maxExpiry = c.expirationDate;
            }
        }

        const accountData = {
            id: crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString() + Math.random().toString().substring(2, 6)),
            name,
            cookies,
            localStorage: lsData,
            expiry: maxExpiry || (Date.now() / 1000 + 86400 * 30),
            savedAt: Date.now()
        };

        const storage = await chrome.storage.local.get({ accounts: [] });
        storage.accounts.push(accountData);
        await chrome.storage.local.set({ accounts: storage.accounts, currentAccountId: accountData.id });

        accNameInput.value = "";
        alert("保存成功！");
        renderAccounts();
    } catch (e) {
        console.error(e);
        alert("保存失败: " + e.message);
    } finally {
        addCurrentBtn.textContent = "保存当前账号信息";
        addCurrentBtn.disabled = false;
    }
});

// 渲染账号列表
async function renderAccounts() {
    const storage = await chrome.storage.local.get({ accounts: [], currentAccountId: null });
    accountList.innerHTML = "";

    // 更新顶部当前使用账号显示及控制区块
    if (storage.currentAccountId) {
        const currAcc = storage.accounts.find(a => a.id === storage.currentAccountId);
        if (currAcc) {
            currentAccountText.textContent = currAcc.name;
            if (saveBox) saveBox.style.display = "none";
        } else {
            currentAccountText.textContent = "未知 / 未保存";
            if (saveBox) saveBox.style.display = "flex";
        }
    } else {
        currentAccountText.textContent = "未知 / 未保存";
        if (saveBox) saveBox.style.display = "flex";
    }

    if (storage.accounts.length === 0) {
        emptyState.style.display = "block";
        return;
    }

    emptyState.style.display = "none";
    storage.accounts.filter(acc => !acc.deleted).forEach(acc => {
        const div = document.createElement("div");
        div.className = "account-item";

        const isExpired = (Date.now() / 1000) > acc.expiry;
        const expiryColor = isExpired ? "var(--danger-color)" : "var(--text-secondary)";
        const d = new Date(acc.expiry * 1000);
        const expiryHTML = isExpired ? "已过期" : `过期: ${d.toLocaleDateString()} ${d.toLocaleTimeString("zh-CN", { hour12: false })}`;
        const isCurrent = acc.id === storage.currentAccountId;

        const lastStatusText = acc.lastStatus || (isCurrent ? accountStatusText.textContent : "未检测");
        const statusColor = lastStatusText.includes("正常") ? "green" : (lastStatusText.includes("未") ? "var(--text-secondary)" : "var(--danger-color)");

        div.innerHTML = `
            <div class="account-header" style="display: flex; flex-direction: column; align-items: stretch; gap: 6px; margin-bottom: 10px;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span class="account-name" style="font-weight: 600; font-size: 14px; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${acc.name}</span>
                    <button class="edit-btn" data-id="${acc.id}" style="padding: 2px 6px; font-size: 10px; border: 1px solid var(--border-color); background: #fff; cursor: pointer; border-radius: 4px; color: var(--text-secondary); white-space: nowrap; outline: none; box-sizing: border-box; height: 20px;">修改备注</button>
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px;">
                    <div style="color: ${statusColor}; font-weight: 500;" id="status-${acc.id}">状态: ${lastStatusText}</div>
                    <div class="account-expiry" style="color: ${expiryColor}; white-space: nowrap;">${expiryHTML}</div>
                </div>
            </div>
            <div class="account-actions">
                <button class="primary-btn switch-btn" data-id="${acc.id}" ${isCurrent ? 'disabled style="background:#80868b;border-color:#80868b;cursor:not-allowed;"' : ''}>${isCurrent ? '正在使用' : '切换'}</button>
                <button class="secondary-btn check-btn" data-id="${acc.id}">检测连通</button>
                <button class="danger-btn delete-btn" data-id="${acc.id}">删除</button>
            </div>
        `;
        accountList.appendChild(div);
    });

    // 绑定事件
    document.querySelectorAll(".switch-btn").forEach(btn => {
        btn.addEventListener("click", (e) => switchAccount(e.target.getAttribute("data-id")));
    });
    document.querySelectorAll(".check-btn").forEach(btn => {
        btn.addEventListener("click", (e) => checkSingleAccount(e.target.getAttribute("data-id")));
    });
    document.querySelectorAll(".delete-btn").forEach(btn => {
        btn.addEventListener("click", (e) => deleteAccount(e.target.getAttribute("data-id")));
    });
    document.querySelectorAll(".edit-btn").forEach(btn => {
        btn.addEventListener("click", (e) => editAccountName(e.target.getAttribute("data-id")));
    });
}

// 切换账号
async function switchAccount(accountId) {
    const tab = await getActiveQccTab();
    if (!tab) {
        alert("请先在当前窗口打开企查查页面，再进行账号切换！");
        return;
    }

    const storage = await chrome.storage.local.get({ accounts: [] });
    const account = storage.accounts.find(a => a.id === accountId);
    if (!account) return;

    if (!confirm(`确定要切换到账号【${account.name}】吗？页面将刷新。`)) return;

    try {
        // 1. 清除当前
        await clearAllQccCookies();

        // 2. 注入 Cookies
        const promises = account.cookies.map(c => {
            const domain = c.domain.startsWith(".") ? c.domain.substring(1) : c.domain;
            const pfx = c.secure ? "https://" : "http://";
            const url = pfx + domain + c.path;

            const newCookie = {
                url: url,
                name: c.name,
                value: c.value,
                domain: c.domain,
                path: c.path,
                secure: c.secure,
                httpOnly: c.httpOnly,
                sameSite: c.sameSite,
                expirationDate: c.expirationDate,
                storeId: c.storeId
            };
            return chrome.cookies.set(newCookie).catch(e => console.warn("Set cookie failed for", c.name, e));
        });
        await Promise.all(promises);

        // 3. 注入 LocalStorage
        await setQccLocalStorage(tab.id, account.localStorage);

        // 更新当前激活的账户 ID
        await chrome.storage.local.set({ currentAccountId: accountId });

        // 4. 发送保活请求状态通知
        chrome.runtime.sendMessage({ action: "resetRenewal" });

        // 5. 刷新页面
        chrome.tabs.reload(tab.id);

        // 可选：关闭 popup
        window.close();
    } catch (e) {
        console.error("切换失败", e);
        alert("切换失败: " + e.message);
    }
}

// 删除账号（软删除，保留墓碑以便同步）
async function deleteAccount(accountId) {
    if (!confirm("确定要删除此账号吗？")) return;
    const storage = await chrome.storage.local.get({ accounts: [], currentAccountId: null });
    const acc = storage.accounts.find(a => a.id === accountId);
    if (!acc) return;

    // 标记为软删除，而非真正移除 —— 让其他设备在同步时也能收到"删除"这一动作
    acc.deleted = true;
    acc.savedAt = Date.now();

    if (storage.currentAccountId === accountId) {
        await chrome.storage.local.set({ accounts: storage.accounts, currentAccountId: null });
    } else {
        await chrome.storage.local.set({ accounts: storage.accounts });
    }
    renderAccounts();
}

// 修改账号备注
async function editAccountName(accountId) {
    const storage = await chrome.storage.local.get({ accounts: [] });
    const acc = storage.accounts.find(a => a.id === accountId);
    if (!acc) return;

    const newName = prompt("请输入新的账号备注名:", acc.name);
    if (newName !== null && newName.trim() !== "") {
        acc.name = newName.trim();
        acc.savedAt = Date.now(); // 极其关键：更新同步时间点，方便另一台电脑判定覆盖
        await chrome.storage.local.set({ accounts: storage.accounts });
        renderAccounts();
    }
}

// 检测列表中某个指定账号的状态 (静默替换 Cookie 测试)
async function checkSingleAccount(accountId) {
    const statusEl = document.getElementById(`status-${accountId}`);
    if (statusEl) statusEl.textContent = "检测中...";

    const storage = await chrome.storage.local.get({ accounts: [] });
    const targetAcc = storage.accounts.find(a => a.id === accountId);
    if (!targetAcc) return;

    // 1. 备份当前浏览器中的 QCC 真实 Cookie
    const currentCookies = await chrome.cookies.getAll({ domain: QCC_DOMAIN });

    try {
        // 2. 清除并打入目标验证账号的 Cookie
        await clearAllQccCookies();
        const promises = targetAcc.cookies.map(c => {
            const domain = c.domain.startsWith(".") ? c.domain.substring(1) : c.domain;
            const pfx = c.secure ? "https://" : "http://";
            return chrome.cookies.set({
                url: pfx + domain + c.path,
                name: c.name, value: c.value, domain: c.domain, path: c.path,
                secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
                expirationDate: c.expirationDate, storeId: c.storeId
            }).catch(() => { });
        });
        await Promise.all(promises);

        // 3. 执行探针请求
        const res = await fetch("https://r.qcc.com/monitor/overview");
        let resultStatus = "正常";
        let statusColor = "green";

        if (res.status === 425) {
            resultStatus = "受阻 (425限制)";
            statusColor = "var(--danger-color)";
        } else if (res.status === 401 || res.status === 403) {
            resultStatus = `失效 (${res.status})`;
            statusColor = "var(--danger-color)";
        } else {
            resultStatus = "正常在线";
        }

        // 4. 更新 UI 和 Storage
        targetAcc.lastStatus = resultStatus;
        await chrome.storage.local.set({ accounts: storage.accounts });
        if (statusEl) {
            statusEl.textContent = "状态: " + resultStatus;
            statusEl.style.color = statusColor;
        }
    } catch (e) {
        console.warn("单体测试抛出错误:", e);
        if (statusEl) {
            statusEl.textContent = "状态: 测不准";
            statusEl.style.color = "var(--text-secondary)";
        }
    } finally {
        // 5. 不论成败，把原来的 Cookie 倒灌回去恢复现场
        await clearAllQccCookies();
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
    }
}

// 一键测活：串行执行所有账号的测试，避免交叉污染 Cookie
checkAllBtn.addEventListener("click", async () => {
    const storage = await chrome.storage.local.get({ accounts: [] });
    if (storage.accounts.length === 0) return alert("暂无保存的账号！");

    checkAllBtn.disabled = true;
    checkAllBtn.textContent = "检测中...";
    checkAllBtn.style.cursor = "wait";

    try {
        for (let acc of storage.accounts) {
            await checkSingleAccount(acc.id);
        }
    } finally {
        checkAllBtn.disabled = false;
        checkAllBtn.textContent = "一键测活";
        checkAllBtn.style.cursor = "pointer";
    }
});

// 新增：退出当前并准备添加新账号
clearAndAddNewBtn.addEventListener("click", async () => {
    const storage = await chrome.storage.local.get({ accounts: [], currentAccountId: null });
    const isSaved = storage.currentAccountId && storage.accounts.some(a => a.id === storage.currentAccountId);

    if (!isSaved) {
        if (!confirm("⚠️您当前使用的账号【还未保存】！\n如果现在添加新账号，当前登录的痕迹将会彻底丢失。\n\n您确定要清空痕迹并录入新账号吗？")) return;
    }

    const tab = await getActiveQccTab();

    try {
        await clearAllQccCookies();
        await chrome.storage.local.remove("currentAccountId");
        if (tab) {
            await setQccLocalStorage(tab.id, {});
            chrome.tabs.reload(tab.id);
        } else {
            // 开一个新标签页
            chrome.tabs.create({ url: QCC_URL });
        }
        alert("清理完毕！请在新页面中登录新的账号，登录成功后再来保存。");
    } catch (e) {
        alert("操作失败: " + e.message);
    }
});

// 新增：检测当前页面的访问状态/是否被限
async function checkAccountStatus() {
    accountStatusText.textContent = "请求鉴权检测中...";

    try {
        // 增测探针：企查查常在被封控时抛出 425 状态码
        const res = await fetch("https://r.qcc.com/monitor/overview");
        if (res.status === 425) {
            accountStatusText.textContent = "访问限制";
            accountStatusText.style.color = "var(--danger-color)";
            return;
        } else if (res.status === 401 || res.status === 403) {
            accountStatusText.textContent = `受阻或掉线 (${res.status})`;
            accountStatusText.style.color = "var(--danger-color)";
            return;
        }
    } catch (e) {
        console.warn("API 鉴权检测抛错，降级采用DOM检测方式", e);
    }

    const tab = await getActiveQccTab();
    if (!tab) {
        accountStatusText.textContent = "请打开页面体验 DOM 检测";
        accountStatusText.style.color = "var(--text-secondary)";
        return;
    }

    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                const text = document.body.innerText || "";
                const url = window.location.href;
                if (url.includes("login")) return "未登录";
                if (url.includes("verify") || (text.includes("验证码") && (text.includes("安全") || text.includes("频繁")))) return "受限 (频繁验证)";
                if (text.includes("超出今日") || text.includes("额度已用完") || text.includes("达到上限") || text.includes("访问过于频繁")) return "额度超限或受阻";
                return "正常在线";
            }
        });
        const status = results[0].result;
        accountStatusText.textContent = status;
        if (status === "正常在线") {
            accountStatusText.style.color = "green";
        } else if (status === "未登录") {
            accountStatusText.style.color = "var(--text-secondary)";
        } else {
            accountStatusText.style.color = "var(--danger-color)";
        }
    } catch (e) {
        accountStatusText.textContent = "状态未知";
    }
}

// ─────── WebDAV 目录模式同步引擎 ───────
// 目录结构：{baseUrl}/manifest.json  轻量索引
//           {baseUrl}/{uuid}.json     每个账号单独文件

if (openOptionsBtn) {
    openOptionsBtn.addEventListener("click", () => {
        chrome.tabs.create({ url: "options.html" });
    });
}

// 获取经过验证的 WebDAV 配置，失败时弹提示并返回 null
async function getWebDAVConfig(silent = false) {
    const storage = await chrome.storage.local.get({ webdav: null });
    const config = storage.webdav;
    if (!config || !config.url) {
        if (!silent) alert("请先点击右下角【⚙️配置】设置您的 WebDAV 信息！");
        return null;
    }
    // 确保 baseUrl 以 / 结尾
    const baseUrl = config.url.endsWith("/") ? config.url : config.url + "/";
    const headers = {};
    if (config.user || config.pass) {
        headers["Authorization"] = "Basic " + btoa(config.user + ":" + config.pass);
    }
    return { baseUrl, headers };
}

// 带超时的单次 WebDAV 请求
async function davFetch(url, method, headers, body = null) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(new DOMException("请求超时(>60s)，请检查 NAS 网络或改用内网地址", "AbortError")), 60000);
    try {
        const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
        clearTimeout(t);
        return res;
    } catch (e) {
        clearTimeout(t);
        throw e;
    }
}

// 读取远端 manifest.json，返回数组或 null
async function fetchManifest(baseUrl, headers) {
    try {
        const res = await davFetch(baseUrl + "manifest.json", "GET", headers);
        if (res.status === 404) return [];
        if (!res.ok) throw new Error("HTTP " + res.status);
        const text = await res.text();
        return text ? JSON.parse(text) : [];
    } catch (e) {
        if (e.name === "AbortError") throw new Error("超时，请检查 NAS 网络连接");
        throw e;
    }
}

// 写入远端 manifest.json
async function putManifest(baseUrl, headers, manifest) {
    const h = { ...headers, "Content-Type": "application/json" };
    const res = await davFetch(baseUrl + "manifest.json", "PUT", h, JSON.stringify(manifest));
    if (!res.ok) throw new Error("manifest PUT 失败 HTTP " + res.status);
}

// 写入单个账号文件（去除非必要 cookie 字段以减小体积）
async function putAccount(baseUrl, headers, acc) {
    const slim = {
        ...acc,
        cookies: (acc.cookies || []).map(c => ({
            name: c.name, value: c.value, domain: c.domain,
            path: c.path, secure: c.secure, sameSite: c.sameSite,
            expirationDate: c.expirationDate
        }))
    };
    const h = { ...headers, "Content-Type": "application/json" };
    const res = await davFetch(baseUrl + acc.id + ".json", "PUT", h, JSON.stringify(slim));
    if (!res.ok) throw new Error("账号 PUT 失败 HTTP " + res.status);
}

// 读取单个账号文件
async function fetchAccount(baseUrl, headers, id) {
    const res = await davFetch(baseUrl + id + ".json", "GET", headers);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error("账号 GET 失败 HTTP " + res.status);
    return JSON.parse(await res.text());
}

// ────── 手动备份按钮（只上传本地有变化的账号）──────
if (uploadSyncBtn) {
    uploadSyncBtn.addEventListener("click", async () => {
        if (!confirm("将把本地有更新的账号增量推送到云端。\n确认备份吗？")) return;
        uploadSyncBtn.disabled = true;
        uploadSyncBtn.textContent = "上传中...";

        try {
            const cfg = await getWebDAVConfig();
            if (!cfg) { uploadSyncBtn.disabled = false; uploadSyncBtn.textContent = "⬆️ 备份到云端"; return; }
            const { baseUrl, headers } = cfg;

            const storage = await chrome.storage.local.get({ accounts: [], lastUploadAt: {} });
            const lastUploadAt = storage.lastUploadAt || {};

            // 读取远端 manifest，得到远端的 savedAt 索引
            const remoteManifest = await fetchManifest(baseUrl, headers);
            const remoteMap = new Map(remoteManifest.map(m => [m.id, m.savedAt || 0]));

            let uploaded = 0;
            const newLastUpload = { ...lastUploadAt };
            const newManifest = [...remoteManifest];
            const manifestMap = new Map(newManifest.map((m, i) => [m.id, i]));

            for (const acc of storage.accounts) {
                const localTime = acc.savedAt || ((acc.expiry || 0) * 1000);
                const remoteTime = remoteMap.get(acc.id) || 0;
                const wasUploaded = lastUploadAt[acc.id] || 0;

                // 只上传"比上次上传新"或"比云端更新"的账号
                if (localTime > wasUploaded || localTime > remoteTime) {
                    await putAccount(baseUrl, headers, acc);

                    newLastUpload[acc.id] = localTime;
                    uploaded++;

                    // 更新 manifest 条目
                    const entry = { id: acc.id, name: acc.name, savedAt: localTime, deleted: acc.deleted || false };
                    if (manifestMap.has(acc.id)) {
                        newManifest[manifestMap.get(acc.id)] = entry;
                    } else {
                        newManifest.push(entry);
                        manifestMap.set(acc.id, newManifest.length - 1);
                    }
                }
            }

            await putManifest(baseUrl, headers, newManifest);
            await chrome.storage.local.set({ lastUploadAt: newLastUpload });
            alert(`备份完成！共推送了 ${uploaded} 个有变化的账号。`);
        } catch (e) {
            if (e.name === "AbortError") {
                alert(e.message || "请求超时，请检查 NAS 网络连接或改用内网 IP 地址");
            } else {
                alert("备份失败：" + e.message);
            }
        }

        uploadSyncBtn.disabled = false;
        uploadSyncBtn.textContent = "⬆️ 备份到云端";
    });
}

// ────── 手动下载按钮（只下载云端比本地新的账号）──────
if (downloadSyncBtn) {
    downloadSyncBtn.addEventListener("click", async () => {
        if (!confirm("将从云端拉取比本地更新的账号进行合并。\n确定同步吗？")) return;
        downloadSyncBtn.disabled = true;
        downloadSyncBtn.textContent = "拉取中...";

        try {
            const cfg = await getWebDAVConfig();
            if (!cfg) { downloadSyncBtn.disabled = false; downloadSyncBtn.textContent = "⬇️ 从云端同步"; return; }
            const { baseUrl, headers } = cfg;

            const remoteManifest = await fetchManifest(baseUrl, headers);
            if (!remoteManifest.length) {
                alert("云端尚未备份过数据，请先上传一次！");
                downloadSyncBtn.disabled = false;
                downloadSyncBtn.textContent = "⬇️ 从云端同步";
                return;
            }

            const storage = await chrome.storage.local.get({ accounts: [] });
            const localMap = new Map(storage.accounts.map(a => [a.id, a]));

            let downloaded = 0;
            for (const entry of remoteManifest) {
                const localAcc = localMap.get(entry.id);
                const localTime = localAcc ? (localAcc.savedAt || ((localAcc.expiry || 0) * 1000)) : 0;
                const remoteTime = entry.savedAt || 0;

                if (remoteTime > localTime) {
                    // 需要更新，下载完整数据
                    const remoteAcc = await fetchAccount(baseUrl, headers, entry.id);
                    if (remoteAcc) {
                        localMap.set(entry.id, remoteAcc);
                        downloaded++;
                    }
                }
            }

            await chrome.storage.local.set({ accounts: Array.from(localMap.values()) });
            alert(`同步完成！共更新了 ${downloaded} 个账号。`);
            renderAccounts();
        } catch (e) {
            if (e.name === "AbortError") {
                alert(e.message || "请求超时，请检查 NAS 网络连接或改用内网 IP 地址");
            } else {
                alert("同步失败：" + e.message);
            }
        }

        downloadSyncBtn.disabled = false;
        downloadSyncBtn.textContent = "⬇️ 从云端同步";
    });
}

// 初始化
document.addEventListener("DOMContentLoaded", () => {
    renderAccounts();
    checkAccountStatus();
});