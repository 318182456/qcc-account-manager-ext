document.addEventListener("DOMContentLoaded", async () => {
    const webdavUrl = document.getElementById("webdavUrl");
    const webdavUser = document.getElementById("webdavUser");
    const webdavPass = document.getElementById("webdavPass");
    const autoSync = document.getElementById("autoSync");
    const saveBtn = document.getElementById("saveBtn");
    const saveStatus = document.getElementById("saveStatus");

    // 取出现有配置
    const storage = await chrome.storage.local.get({ webdav: null, autoSync: true });
    if (storage.webdav) {
        webdavUrl.value = storage.webdav.url || "";
        webdavUser.value = storage.webdav.user || "";
        webdavPass.value = storage.webdav.pass || "";
    }
    autoSync.checked = storage.autoSync;

    saveBtn.addEventListener("click", async () => {
        const url = webdavUrl.value.trim();
        const user = webdavUser.value.trim();
        const pass = webdavPass.value;

        if (!url) {
            alert("请至少填写 WebDAV 的 URL！");
            return;
        }

        await chrome.storage.local.set({
            webdav: { url, user, pass },
            autoSync: autoSync.checked
        });

        saveStatus.style.display = "block";
        setTimeout(() => {
            saveStatus.style.display = "none";
        }, 3000);
    });
});
