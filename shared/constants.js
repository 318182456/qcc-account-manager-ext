/**
 * 共通常量定义
 * popup.js 通过 <script> 引入，background.js 通过 importScripts() 引入
 */

// ─── URL & 域名 ───
const QCC_URL = "https://www.qcc.com";
const QCC_INDEX_URL = "https://www.qcc.com/";
const QCC_DOMAIN = "qcc.com";
const QCC_MATCH_PATTERN = "*://*.qcc.com/*";
const QCC_PROBE_URL = "https://r.qcc.com/monitor/overview";

// ─── 核心 Cookie 名 ───
const CORE_COOKIE_NAMES = ["QCCSESSID", "Token"];
const IDENTITY_COOKIE_NAME = "_c_WBKFRo";

// ─── 时间常量（秒） ───
const ONE_DAY_SEC = 86400;
const DEFAULT_EXPIRY_DAYS = 15;
const DEFAULT_EXPIRY_SEC = DEFAULT_EXPIRY_DAYS * ONE_DAY_SEC;
const EXPIRY_WARNING_DAYS = 3;        // 过期预警阈值（天）
const RENEWAL_INTERVAL_SEC = 5000;    // 全员保活每账号间隔（毫秒）

// ─── LocalStorage 过滤规则 ───
const LS_MAX_VALUE_LENGTH = 5000;
const LS_EXCLUDE_KEYS = ["redux-persist"];
const LS_EXCLUDE_PATTERNS = ["cache", "history"];
const LS_EXCLUDE_PREFIXES = ["AMap"];

// ─── Alarm 名 ───
const RENEWAL_ALARM_NAME = "qcc-session-renewal";
const SYNC_ALARM_NAME = "qcc-auto-sync";
const ALL_RENEWAL_ALARM_NAME = "qcc-all-session-renewal";

// ─── Alarm 周期（分钟） ───
const RENEWAL_INTERVAL_MIN = 25;
const SYNC_INTERVAL_MIN = 30;
const ALL_RENEWAL_INTERVAL_MIN = 180;

// ─── 通知图标（PNG 文件路径，Chrome 通知不支持 SVG base64） ───
const NOTIFICATION_ICON_URL = "icon_notify.png";

// ─── WebDAV 超时（毫秒） ───
const WEBDAV_TIMEOUT_MS = 60000;

// ─── 墓碑清理周期（毫秒） ───
const TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000;
