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
const syncBtn = document.getElementById("syncBtn");
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
            func: () => {
                const data = {};
                for (let i = 0; i < window.localStorage.length; i++) {
                    const key = window.localStorage.key(i);
                    const val = window.localStorage.getItem(key) || "";
                    if (val.length < 5000 && !key.toLowerCase().includes("cache") && !key.toLowerCase().includes("history") && key !== "redux-persist" && !key.includes("AMap")) {
                        data[key] = val;
                    }
                }
                return JSON.stringify(data);
            }
        });
        return JSON.parse(results[0].result);
    } catch (e) {
        console.error("获取 LocalStorage 失败", e);
        return {};
    }
}

// 向页面注入目标 LocalStorage
async function setQccLocalStorage(tabId, lsData) {
    const safeData = lsData || {};
    await chrome.scripting.executeScript({
        target: { tabId },
        func: (dataStr) => {
            window.localStorage.clear();
            window.sessionStorage.clear(); // 新增：清除 sessionStorage 以防止其他账号的退出状态残留
            const data = JSON.parse(dataStr);
            for (let key in data) {
                window.localStorage.setItem(key, data[key]);
            }
        },
        args: [JSON.stringify(safeData)]
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

// 保存核心逻辑
async function performSaveAccount(nameToSave) {
    const tab = await getActiveQccTab();
    if (!tab) throw new Error("不在企查查页面或未加载完毕。");

    const cookies = await chrome.cookies.getAll({ domain: "qcc.com" });
    const lsData = await getQccLocalStorage(tab.id);

    let maxExpiry = 0;
    let hasCoreCookie = false;
    for (let c of cookies) {
        if (["QCCSESSID", "Token"].includes(c.name)) {
            if (c.expirationDate && c.expirationDate > maxExpiry) {
                maxExpiry = c.expirationDate;
            }
            hasCoreCookie = true;
        }
    }

    const isLoggedOut = !lsData['_l_KPLiPs'] && (maxExpiry === 0 || !hasCoreCookie);
    let statusText = "正常在线 (本地更新)";

    if (isLoggedOut) {
        maxExpiry = Math.floor(Date.now() / 1000) - 1;
        statusText = "已注销 (无登录凭证)";
    } else if (!hasCoreCookie || maxExpiry === 0) {
        maxExpiry = Math.floor(Date.now() / 1000) + 15 * 24 * 3600;
    }

    const storage = await chrome.storage.local.get({ accounts: [], currentAccountId: null });

    let accountId;
    const existingAccIndex = storage.accounts.findIndex(a => a.id === storage.currentAccountId);

    if (storage.currentAccountId && existingAccIndex !== -1) {
        accountId = storage.currentAccountId;
        storage.accounts[existingAccIndex] = {
            ...storage.accounts[existingAccIndex],
            name: nameToSave || storage.accounts[existingAccIndex].name,
            cookies,
            localStorage: lsData,
            expiry: maxExpiry,
            savedAt: Date.now(),
            lastStatus: statusText,
            deleted: false
        };
    } else {
        if (!nameToSave) return; // 隐式自动更新时不创建新账号
        accountId = crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString() + Math.random().toString().substring(2, 6));
        const accountData = {
            id: accountId,
            name: nameToSave,
            cookies,
            localStorage: lsData,
            expiry: maxExpiry,
            savedAt: Date.now(),
            lastStatus: statusText,
            deleted: false
        };
        storage.accounts.push(accountData);
    }

    await chrome.storage.local.set({ accounts: storage.accounts, currentAccountId: accountId });
    chrome.runtime.sendMessage({ action: "triggerSync" });
}

// 保存当前账号
addCurrentBtn.addEventListener("click", async () => {
    const name = accNameInput.value.trim();
    if (!name) return alert("请输入账号备注");

    addCurrentBtn.textContent = "保存中...";
    addCurrentBtn.disabled = true;

    try {
        await performSaveAccount(name);

        const storage = await chrome.storage.local.get({ currentAccountId: null });
        if (!storage.currentAccountId) accNameInput.value = "";

        alert("保存/更新成功！");
        renderAccounts();
    } catch (e) {
        console.error(e);
        alert("操作失败: " + e.message);
    } finally {
        addCurrentBtn.textContent = "保存/更新账号信息";
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
            if (saveBox) {
                // 探测当前实时的 Cookie 状态
                const liveCookies = await chrome.cookies.getAll({ domain: "qcc.com" });
                let liveMax = 0;
                let hasCore = false;
                let liveSessId = "";
                for (let c of liveCookies) {
                    if (c.name === "QCCSESSID") liveSessId = c.value;
                    if (["QCCSESSID", "Token"].includes(c.name)) {
                        if (c.expirationDate && c.expirationDate > liveMax) liveMax = c.expirationDate;
                        hasCore = true;
                    }
                }
                const nowSec = Date.now() / 1000;

                let dbSessId = "";
                for (let c of (currAcc.cookies || [])) {
                    if (c.name === "QCCSESSID") dbSessId = c.value;
                }

                // 数据库记录中是否已过期或注销
                const dbExpired = nowSec > currAcc.expiry || (currAcc.lastStatus && (currAcc.lastStatus.includes("失效") || currAcc.lastStatus.includes("已注销")));
                // 会话是否发生了更换 (比如用户在网页上重新登录了)
                const cookieChanged = liveSessId && dbSessId && liveSessId !== dbSessId;

                // 浏览器当前是否已经拿到了新的有效票据 (如果 expirationDate 比现在多 2 天以上，或者没设过期日即 Session)
                const liveValid = hasCore && (liveMax === 0 || liveMax > nowSec + 86400);

                if (liveValid && (cookieChanged || dbExpired)) {
                    // 自动无感更新，无需用户点击
                    accountStatusText.textContent = "检测到新凭证，正在自动提取并同步...";
                    try {
                        await performSaveAccount(currAcc.name);
                        return renderAccounts(); // 重新走一次渲染和判断，中止当前渲染
                    } catch (e) {
                        console.warn("自动更新静默失败", e);
                    }
                }

                if (dbExpired || cookieChanged) {
                    saveBox.style.display = "flex";
                    accNameInput.value = currAcc.name;
                    if (!liveValid) {
                        addCurrentBtn.textContent = "请先在网页登录后再更新";
                        addCurrentBtn.disabled = true;
                    } else {
                        addCurrentBtn.textContent = "更新这个账号";
                        addCurrentBtn.disabled = false;
                    }
                } else {
                    // 如果账号正常在线并未过期，就不需要显示更新框（恢复原有的干净界面）
                    saveBox.style.display = "none";
                }
            }
        } else {
            currentAccountText.textContent = "未知 / 未保存";
            if (saveBox) {
                saveBox.style.display = "flex";
                accNameInput.value = "";
                addCurrentBtn.textContent = "保存为新账号";
            }
        }
    } else {
        currentAccountText.textContent = "未知 / 未保存";
        if (saveBox) {
            saveBox.style.display = "flex";
            accNameInput.value = "";
            addCurrentBtn.textContent = "保存为新账号";
        }
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
        const d = new Date(acc.expiry * 1000);
        const expiryStr = isExpired
            ? "⚠️ 已过期"
            : `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" })} 到期`;
        const expiryColor = isExpired ? "var(--danger)" : "var(--text-dim)";
        const isCurrent = acc.id === storage.currentAccountId;

        const lastStatusText = acc.lastStatus || (isCurrent ? accountStatusText.textContent : "未检测");
        const isNormal = lastStatusText.includes("正常");
        const isUnknown = lastStatusText.includes("未") || lastStatusText.includes("检测");
        const statusDot = isNormal ? "var(--success)" : isUnknown ? "var(--text-dim)" : "var(--danger)";

        div.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                <div style="display:flex; align-items:center; gap:7px; min-width:0;">
                    <span style="width:7px;height:7px;border-radius:50%;background:${statusDot};flex-shrink:0;margin-top:2px;"></span>
                    <span style="font-weight:600;font-size:13px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px;">${acc.name}</span>
                </div>
                <button class="edit-btn" data-id="${acc.id}" style="background:transparent;border:none;color:var(--text-dim);font-size:11px;padding:0 2px;cursor:pointer;flex-shrink:0;font-weight:400;">✏️</button>
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center; margin-top:5px; font-size:11px;">
                <span style="color:${statusDot}; font-weight:500;" id="status-${acc.id}">${lastStatusText}</span>
                <span style="color:${expiryColor};">${expiryStr}</span>
            </div>
            <div class="account-actions">
                <button class="primary-btn switch-btn" data-id="${acc.id}" ${isCurrent ? 'disabled style="background:#94a3b8;box-shadow:none;cursor:not-allowed;"' : ''}>${isCurrent ? "正在使用" : (isExpired ? "🔑 重登" : "切换")}</button>
                <button class="secondary-btn check-btn" data-id="${acc.id}">检测</button>
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
    chrome.runtime.sendMessage({ action: "triggerSync" });
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
        chrome.runtime.sendMessage({ action: "triggerSync" });
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

        if (res.redirected && res.url.includes("login")) {
            resultStatus = "已注销";
            statusColor = "var(--text-secondary)";
        } else if (res.status === 425) {
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
            statusEl.textContent = resultStatus;
            statusEl.style.color = statusColor;
        }
    } catch (e) {
        console.warn("单体测试抛出错误:", e);
        if (statusEl) {
            statusEl.textContent = "测不准";
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
        if (res.redirected && res.url.includes("login")) {
            accountStatusText.textContent = "已注销";
            accountStatusText.style.color = "var(--text-secondary)";
            return;
        } else if (res.status === 425) {
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
        accountStatusText.innerHTML = '<a href="#" id="jumpToQcc" style="color:var(--text-secondary); text-decoration:underline;">请打开页面体验 DOM 检测 (点击前往)</a>';
        document.getElementById("jumpToQcc").addEventListener("click", (e) => {
            e.preventDefault();
            chrome.tabs.create({ url: QCC_URL });
        });
        return;
    }

    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                const text = document.body.innerText || "";
                const url = window.location.href;
                if (url.includes("login")) return "已注销";
                if (url.includes("verify") || (text.includes("验证码") && (text.includes("安全") || text.includes("频繁")))) return "受限 (频繁验证)";
                if (text.includes("超出今日") || text.includes("额度已用完") || text.includes("达到上限") || text.includes("访问过于频繁")) return "额度超限或受阻";
                return "正常在线";
            }
        });
        const status = results[0].result;
        accountStatusText.textContent = status;
        if (status === "正常在线") {
            accountStatusText.style.color = "green";
        } else if (status === "已注销") {
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

if (syncBtn) {
    syncBtn.addEventListener("click", async () => {
        syncBtn.disabled = true;
        syncBtn.textContent = "同步中...";
        try {
            const response = await chrome.runtime.sendMessage({ action: "triggerSync" });
            if (response && response.success) {
                if (response.changed) {
                    alert("双向同步完成，数据有更新！");
                    renderAccounts();
                } else {
                    alert("双向同步完成，云端和本地均已是最新状态。");
                }
            } else {
                alert("同步失败: " + (response && response.error ? response.error : "请检查是否已在【配置】页面填好服务器参数！"));
            }
        } catch (e) {
            alert("通信失败: " + e.message);
        } finally {
            syncBtn.disabled = false;
            syncBtn.textContent = "🔄 立即同步";
        }
    });
}

// 初始化
document.addEventListener("DOMContentLoaded", () => {
    renderAccounts();
    checkAccountStatus();
});