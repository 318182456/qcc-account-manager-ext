/**
 * popup.js — 企查查多账号管理扩展 Popup 前端
 * 依赖: shared/constants.js, shared/utils.js（已在 popup.html 中按序引入）
 */

// ─── DOM 元素 ───
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

// ─── 格式化工具 ───

/** 格式化过期时间 */
function formatExpiry(timestampSec) {
    if (!timestampSec) return "未知";
    return new Date(timestampSec * 1000).toLocaleString();
}

/** 格式化时间距离 */
function formatTimeAgo(ts) {
    if (!ts) return "从未";
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "刚刚";
    if (mins < 60) return `${mins} 分钟前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} 小时前`;
    return `${Math.floor(hours / 24)} 天前`;
}

// ─── Tab 查询 ───

/** 检查当前激活标签是否是企查查页面 */
async function getActiveQccTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url.includes(QCC_DOMAIN)) return null;
    return tab;
}

/** 查找任意已打开的企查查标签 */
async function getAnyQccTab() {
    const tabs = await chrome.tabs.query({ url: QCC_MATCH_PATTERN });
    return tabs.length > 0 ? tabs[0] : null;
}

// ─── LocalStorage 操作 ───

/** 从当前页面获取 LocalStorage（在页面上下文中执行，返回过滤后的数据） */
async function getQccLocalStorage(tabId) {
    try {
        // 注意：executeScript 中的 func 运行在页面上下文，不能访问外部变量
        // 过滤规则需内联传入
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: (maxLen, excludeKeys, excludePatterns, excludePrefixes) => {
                const data = {};
                for (let i = 0; i < window.localStorage.length; i++) {
                    const key = window.localStorage.key(i);
                    const val = window.localStorage.getItem(key) || "";
                    if (val.length >= maxLen) continue;
                    const lk = key.toLowerCase();
                    if (excludePatterns.some(p => lk.includes(p))) continue;
                    if (excludeKeys.includes(key)) continue;
                    if (excludePrefixes.some(p => key.includes(p))) continue;
                    data[key] = val;
                }
                return JSON.stringify(data);
            },
            args: [LS_MAX_VALUE_LENGTH, LS_EXCLUDE_KEYS, LS_EXCLUDE_PATTERNS, LS_EXCLUDE_PREFIXES]
        });
        return JSON.parse(results[0].result);
    } catch (e) {
        console.error("获取 LocalStorage 失败", e);
        return {};
    }
}

/** 向页面注入目标 LocalStorage */
async function setQccLocalStorage(tabId, lsData) {
    await chrome.scripting.executeScript({
        target: { tabId },
        func: (dataStr) => {
            window.localStorage.clear();
            window.sessionStorage.clear();
            const data = JSON.parse(dataStr);
            for (const key in data) {
                window.localStorage.setItem(key, data[key]);
            }
        },
        args: [JSON.stringify(lsData || {})]
    });
}

// ─── 账号保存核心 ───

async function performSaveAccount(nameToSave) {
    const tab = await getActiveQccTab();
    if (!tab) throw new Error("不在企查查页面或未加载完毕。");

    const cookies = await chrome.cookies.getAll({ domain: QCC_DOMAIN });
    const lsData = await getQccLocalStorage(tab.id);

    const { maxExpiry: rawExpiry, hasCore } = calcMaxExpiry(cookies);

    const isLoggedOut = !lsData['_l_KPLiPs'] && (rawExpiry === 0 || !hasCore);
    let statusText = "正常在线 (本地更新)";
    let maxExpiry = rawExpiry;

    if (isLoggedOut) {
        maxExpiry = Math.floor(Date.now() / 1000) - 1;
        statusText = "已注销 (无登录凭证)";
    } else {
        maxExpiry = ensureExpiry(rawExpiry, hasCore);
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
        storage.accounts.push({
            id: accountId,
            name: nameToSave,
            cookies,
            localStorage: lsData,
            expiry: maxExpiry,
            savedAt: Date.now(),
            lastStatus: statusText,
            deleted: false
        });
    }

    await chrome.storage.local.set({ accounts: storage.accounts, currentAccountId: accountId });
    chrome.runtime.sendMessage({ action: "triggerSync" });
}

// ─── 保存按钮事件 ───

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

// ─── 渲染账号列表 ───

async function renderAccounts() {
    let storage = await chrome.storage.local.get({ accounts: [], currentAccountId: null });

    // 阶段1：Cookie 匹配
    const liveCookies = await chrome.cookies.getAll({ domain: QCC_DOMAIN });
    let liveWBKey = "", liveSessId = "";
    const { maxExpiry: liveMax, hasCore } = calcMaxExpiry(liveCookies);

    for (const c of liveCookies) {
        if (c.name === IDENTITY_COOKIE_NAME) liveWBKey = c.value;
        if (c.name === "QCCSESSID") liveSessId = c.value;
    }

    const nowSec = Date.now() / 1000;
    const liveValid = hasCore && (liveMax === 0 || liveMax > nowSec + ONE_DAY_SEC);

    // 全量账号中查找 Cookie 匹配
    const matchedAcc = storage.accounts.find(acc => {
        if (acc.deleted) return false;
        const accWBKey = (acc.cookies || []).find(c => c.name === IDENTITY_COOKIE_NAME)?.value || "";
        const accSessId = (acc.cookies || []).find(c => c.name === "QCCSESSID")?.value || "";
        if (liveWBKey && accWBKey) return liveWBKey === accWBKey;
        if (liveSessId && accSessId) return liveSessId === accSessId;
        return false;
    });

    // 内存中修正 currentAccountId
    if (matchedAcc) {
        if (matchedAcc.id !== storage.currentAccountId) {
            storage.currentAccountId = matchedAcc.id;
            chrome.storage.local.set({ currentAccountId: matchedAcc.id });
        }
    } else if (liveValid && storage.currentAccountId) {
        storage.currentAccountId = null;
        chrome.storage.local.remove("currentAccountId");
    }

    // 阶段2：DOM 渲染
    accountList.innerHTML = "";

    const currAcc = matchedAcc
        || (storage.currentAccountId ? storage.accounts.find(a => a.id === storage.currentAccountId && !a.deleted) : null);

    if (saveBox) {
        if (currAcc) {
            currentAccountText.textContent = currAcc.name;
            const dbExpired = nowSec > currAcc.expiry ||
                (currAcc.lastStatus && (currAcc.lastStatus.includes("失效") || currAcc.lastStatus.includes("已注销")));

            if (liveValid && dbExpired) {
                accountStatusText.textContent = "检测到新凭证，正在自动提取并同步...";
                saveBox.style.display = "none";
                performSaveAccount(currAcc.name)
                    .then(() => renderAccounts())
                    .catch(e => console.warn("自动更新失败", e));
            } else if (dbExpired) {
                saveBox.style.display = "flex";
                accNameInput.value = currAcc.name;
                addCurrentBtn.textContent = liveValid ? "更新这个账号" : "请先在网页登录后再更新";
                addCurrentBtn.disabled = !liveValid;
            } else {
                saveBox.style.display = "none";
            }
        } else if (liveValid) {
            currentAccountText.textContent = "未知 / 未保存";
            saveBox.style.display = "flex";
            accNameInput.value = "";
            addCurrentBtn.textContent = "保存当前账号";
            addCurrentBtn.disabled = false;
        } else {
            currentAccountText.textContent = "未登录";
            saveBox.style.display = "none";
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
                    ${isCurrent ? '<span style="font-size:10px;background:rgba(99,102,241,0.2);color:#a5b4fc;border:1px solid rgba(99,102,241,0.4);padding:1px 6px;border-radius:20px;flex-shrink:0;">使用中</span>' : ""}
                </div>
                <button class="edit-btn" data-id="${acc.id}" style="background:transparent;border:none;color:var(--text-dim);font-size:11px;padding:0 2px;cursor:pointer;flex-shrink:0;font-weight:400;">✏️</button>
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center; margin-top:5px; font-size:11px;">
                <span style="color:${statusDot}; font-weight:500;" id="status-${acc.id}">${lastStatusText}</span>
                <span style="color:${expiryColor};">${expiryStr}</span>
            </div>
            <div class="account-actions">
                <button class="primary-btn switch-btn" data-id="${acc.id}">${isExpired ? "🔑 重登" : "切换"}</button>
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

// ─── 切换账号 ───

async function switchAccount(accountId) {
    accountStatusText.textContent = "切换中...";
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
        await clearAllQccCookies();
        await injectCookies(account.cookies);
        await setQccLocalStorage(tab.id, account.localStorage);
        await chrome.storage.local.set({ currentAccountId: accountId });
        chrome.runtime.sendMessage({ action: "resetRenewal" });
        chrome.tabs.reload(tab.id);
        window.close();
    } catch (e) {
        console.error("切换失败", e);
        alert("切换失败: " + e.message);
    }
}

// ─── 删除账号（软删除） ───

async function deleteAccount(accountId) {
    if (!confirm("确定要删除此账号吗？")) return;
    const storage = await chrome.storage.local.get({ accounts: [], currentAccountId: null });
    const acc = storage.accounts.find(a => a.id === accountId);
    if (!acc) return;

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

// ─── 修改账号备注 ───

async function editAccountName(accountId) {
    const storage = await chrome.storage.local.get({ accounts: [] });
    const acc = storage.accounts.find(a => a.id === accountId);
    if (!acc) return;

    const newName = prompt("请输入新的账号备注名:", acc.name);
    if (newName !== null && newName.trim() !== "") {
        acc.name = newName.trim();
        acc.savedAt = Date.now();
        await chrome.storage.local.set({ accounts: storage.accounts });
        renderAccounts();
        chrome.runtime.sendMessage({ action: "triggerSync" });
    }
}

// ─── 单账号检测 ───

/**
 * 检测单个账号
 *
 * 非当前账号一律只做本地凭证检查，不再「注入 Cookie → 发请求 → 还原」：
 * 那套做法会把浏览器全局身份改成别人的，是账号被服务器踢下线的主要原因。
 * 真实的网络检测交由 background 的隔离保活（隐身容器）完成。
 */
async function checkSingleAccount(accountId) {
    const statusEl = document.getElementById(`status-${accountId}`);
    if (statusEl) statusEl.textContent = "检测中...";

    const storage = await chrome.storage.local.get({ accounts: [], currentAccountId: null });
    const targetAcc = storage.accounts.find(a => a.id === accountId);
    if (!targetAcc) return;

    const isCurrent = targetAcc.id === storage.currentAccountId;
    let resultStatus;
    let statusColor;

    if (isCurrent) {
        // 当前账号：用它自己的身份发请求，无风险
        try {
            const res = await fetch(QCC_PROBE_URL, { credentials: "include" });
            if (res.redirected && res.url.includes("login")) {
                resultStatus = "已注销";
                statusColor = "var(--text-muted)";
            } else if (res.status === 425) {
                resultStatus = "受阻 (425限制)";
                statusColor = "var(--danger)";
            } else if (res.status === 401 || res.status === 403) {
                resultStatus = `失效 (${res.status})`;
                statusColor = "var(--danger)";
            } else {
                resultStatus = "正常在线";
                statusColor = "var(--success)";
            }
        } catch (e) {
            console.warn("当前账号检测抛错:", e);
            resultStatus = "测不准";
            statusColor = "var(--text-muted)";
        }
    } else {
        // 其他账号：仅凭本地 Cookie 有效期判断
        const { maxExpiry, hasCore } = calcMaxExpiry(targetAcc.cookies);
        const nowSec = Date.now() / 1000;

        if (!hasCore) {
            resultStatus = "无凭证";
            statusColor = "var(--danger)";
        } else if (maxExpiry > 0 && maxExpiry <= nowSec) {
            resultStatus = "已过期";
            statusColor = "var(--danger)";
        } else {
            const hoursLeft = maxExpiry > 0 ? (maxExpiry - nowSec) / 3600 : Infinity;
            resultStatus = hoursLeft < 24
                ? `凭证有效 (剩 ${hoursLeft.toFixed(0)}h)`
                : "凭证有效";
            statusColor = hoursLeft < 24 ? "var(--warning, orange)" : "var(--success)";
        }
    }

    targetAcc.lastStatus = resultStatus;
    await chrome.storage.local.set({ accounts: storage.accounts });
    if (statusEl) {
        statusEl.textContent = resultStatus;
        statusEl.style.color = statusColor;
    }
}

// ─── 一键测活 ───

checkAllBtn.addEventListener("click", async () => {
    const storage = await chrome.storage.local.get({ accounts: [] });
    if (storage.accounts.length === 0) return alert("暂无保存的账号！");

    checkAllBtn.disabled = true;
    checkAllBtn.textContent = "检测中...";
    checkAllBtn.style.cursor = "wait";

    try {
        // 全部为本地检查（当前账号最多一个请求），可直接串行
        for (const acc of storage.accounts.filter(a => !a.deleted)) {
            await checkSingleAccount(acc.id);
        }
    } finally {
        checkAllBtn.disabled = false;
        checkAllBtn.textContent = "一键测活";
        checkAllBtn.style.cursor = "pointer";
    }
});

// ─── 添加新账号 ───

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
            chrome.tabs.create({ url: QCC_URL });
        }
        alert("清理完毕！请在新页面中登录新的账号，登录成功后再来保存。");
    } catch (e) {
        alert("操作失败: " + e.message);
    }
});

// ─── 当前页面状态检测 ───

async function checkAccountStatus() {
    accountStatusText.textContent = "请求鉴权检测中...";

    try {
        const res = await fetch(QCC_PROBE_URL);
        if (res.redirected && res.url.includes("login")) {
            accountStatusText.textContent = "已注销";
            accountStatusText.style.color = "var(--text-muted)";
            return;
        } else if (res.status === 425) {
            accountStatusText.textContent = "访问限制";
            accountStatusText.style.color = "var(--danger)";
            return;
        } else if (res.status === 401 || res.status === 403) {
            accountStatusText.textContent = `受阻或掉线 (${res.status})`;
            accountStatusText.style.color = "var(--danger)";
            return;
        }
    } catch (e) {
        console.warn("API 鉴权检测抛错，降级采用DOM检测方式", e);
    }

    const tab = await getActiveQccTab();
    if (!tab) {
        accountStatusText.innerHTML = `<a href="#" id="jumpToQcc" style="color:var(--text-muted); text-decoration:underline;">请打开页面体验 DOM 检测 (点击前往)</a>`;
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
            accountStatusText.style.color = "var(--text-muted)";
        } else {
            accountStatusText.style.color = "var(--danger)";
        }

        // 关键修复：如果检测到状态和存储中的不一致（如检测到已注销），同步回存储
        const storage = await chrome.storage.local.get({ accounts: [], currentAccountId: null });
        if (storage.currentAccountId) {
            const currIdx = storage.accounts.findIndex(a => a.id === storage.currentAccountId);
            if (currIdx !== -1 && storage.accounts[currIdx].lastStatus !== status) {
                storage.accounts[currIdx].lastStatus = status;
                await chrome.storage.local.set({ accounts: storage.accounts });
            }
        }
    } catch (e) {
        accountStatusText.textContent = "状态未知";
    }
}

// ─── 同步按钮 & 配置按钮 ───

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

// ─── Tab 切换 ───

document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        const tab = btn.getAttribute("data-tab");
        document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
        document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById("tab-" + tab).classList.add("active");
        if (tab === "devices") renderDevices();
    });
});

// ─── 设备列表 ───

async function renderDevices() {
    const deviceListEl = document.getElementById("deviceList");
    const countBadge = document.getElementById("deviceCountBadge");
    deviceListEl.innerHTML = `<div class="empty-state">加载中...</div>`;

    const { deviceId, deviceName } = await chrome.storage.local.get({ deviceId: null, deviceName: null });

    const deviceNameInput = document.getElementById("deviceNameInput");
    if (deviceName) deviceNameInput.value = deviceName;

    const { webdav } = await chrome.storage.local.get({ webdav: null });
    if (!webdav || !webdav.url) {
        deviceListEl.innerHTML = `<div class="empty-state">请先在⚙️配置页填写 WebDAV 参数。</div>`;
        countBadge.textContent = "0";
        return;
    }

    const baseUrl = normalizeBaseUrl(webdav.url);
    const headers = buildWebdavHeaders(webdav);

    try {
        const res = await fetch(baseUrl + "devices.json", { headers });
        if (!res.ok) {
            deviceListEl.innerHTML = `<div class="empty-state">暂无设备记录（首次同步后自动生成）。</div>`;
            countBadge.textContent = "0";
            return;
        }
        const devices = JSON.parse(await res.text());
        countBadge.textContent = devices.length;
        deviceListEl.innerHTML = "";

        devices.sort((a, b) => (b.lastSyncAt || 0) - (a.lastSyncAt || 0));

        devices.forEach(dev => {
            const isSelf = dev.id === deviceId;
            const item = document.createElement("div");
            item.className = "device-item" + (isSelf ? " is-self" : "");

            const syncTime = formatTimeAgo(dev.lastSyncAt);
            const syncFull = dev.lastSyncAt ? new Date(dev.lastSyncAt).toLocaleString() : "—";
            const name = dev.name || "未知设备";
            const icon = /windows/i.test(name) ? "🖥️" : /mac/i.test(name) ? "💻" : "📱";
            const verText = dev.version ? `v${dev.version}` : "";

            item.innerHTML = `
                <span class="device-icon">${icon}</span>
                <div class="device-info">
                    <div class="device-name">${name}${verText ? ` <span style="font-size:10px;color:var(--text-dim);font-weight:400;">${verText}</span>` : ""}</div>
                    <div class="device-meta" title="${syncFull}">最后同步: ${syncTime}</div>
                </div>
                ${isSelf ? '<span class="device-self-badge">本机</span>' : ""}
            `;
            deviceListEl.appendChild(item);
        });
    } catch (e) {
        deviceListEl.innerHTML = `<div class="empty-state">读取失败: ${e.message}</div>`;
        countBadge.textContent = "—";
    }
}

document.getElementById("refreshDevicesBtn").addEventListener("click", () => renderDevices());

document.getElementById("saveDeviceNameBtn").addEventListener("click", async () => {
    const input = document.getElementById("deviceNameInput");
    const newName = input.value.trim();
    if (!newName) return;

    const btn = document.getElementById("saveDeviceNameBtn");
    btn.textContent = "保存中...";
    btn.disabled = true;

    try {
        const { deviceId } = await chrome.storage.local.get({ deviceId: null });
        await chrome.storage.local.set({ deviceName: newName });

        const { webdav } = await chrome.storage.local.get({ webdav: null });
        if (webdav && webdav.url && deviceId) {
            const baseUrl = normalizeBaseUrl(webdav.url);
            const headers = buildWebdavHeaders(webdav);
            const res = await fetch(baseUrl + "devices.json", { headers });
            let devices = [];
            if (res.ok) devices = JSON.parse(await res.text());
            const extVersion = chrome.runtime.getManifest().version;
            const existing = devices.find(d => d.id === deviceId);
            if (existing) {
                existing.name = newName;
                existing.lastSyncAt = Date.now();
                existing.version = extVersion;
            } else {
                devices.push({ id: deviceId, name: newName, lastSyncAt: Date.now(), version: extVersion });
            }
            await fetch(baseUrl + "devices.json", {
                method: "PUT",
                headers: { ...headers, "Content-Type": "application/json" },
                body: JSON.stringify(devices)
            });
        }
        await renderDevices();
    } catch (e) {
        alert("保存失败: " + e.message);
    } finally {
        btn.textContent = "保存";
        btn.disabled = false;
    }
});

// ─── 热重载检测 ───

async function checkAndHotReload() {
    const STORE_KEY = "ext_version";
    try {
        const { webdav } = await chrome.storage.local.get({ webdav: null });
        if (!webdav?.url) return;

        const baseUrl = normalizeBaseUrl(webdav.url);
        const headers = buildWebdavHeaders(webdav);

        const res = await fetch(baseUrl + "version.json", { headers, cache: "no-store" });
        if (!res.ok) return;

        const { version } = await res.json();
        if (!version) return;

        const { [STORE_KEY]: localVersion } = await chrome.storage.local.get(STORE_KEY);

        if (!localVersion) {
            await chrome.storage.local.set({ [STORE_KEY]: version });
            return;
        }

        if (version > localVersion) {
            await chrome.storage.local.set({ [STORE_KEY]: version });
            chrome.runtime.reload();
        }
    } catch (_) {
        // 静默失败
    }
}

// ─── 初始化 ───

document.addEventListener("DOMContentLoaded", () => {
    checkAndHotReload();
    renderAccounts();
    // 状态检测完成后重新渲染，拾取 background 同步更新的 lastStatus
    checkAccountStatus().then(() => renderAccounts());
});

// 监听 storage 变化：background 更新账号状态后自动刷新列表
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.accounts) {
        renderAccounts();
    }
});