/**
 * 共通常量定义
 * popup.js 通过 <script> 引入，background.js 通过 importScripts() 引入
 */

// ─── URL & 域名 ───
const QCC_URL = "https://www.qcc.com";
const QCC_INDEX_URL = "https://www.qcc.com/";
const QCC_DOMAIN = "qcc.com";
const QCC_MATCH_PATTERN = "*://*.qcc.com/*";
// 探针改为首页：业务接口（如 r.qcc.com/monitor/overview）风控权重远高于首页
const QCC_PROBE_URL = QCC_INDEX_URL;

// ─── 核心 Cookie 名 ───
const CORE_COOKIE_NAMES = ["QCCSESSID", "Token"];
const IDENTITY_COOKIE_NAME = "_c_WBKFRo";

// ─── 时间常量（秒） ───
const ONE_DAY_SEC = 86400;
const DEFAULT_EXPIRY_DAYS = 15;
const DEFAULT_EXPIRY_SEC = DEFAULT_EXPIRY_DAYS * ONE_DAY_SEC;
const EXPIRY_WARNING_DAYS = 3;        // 过期预警阈值（天）

// ─── 全员保活节流（毫秒） ───
// 原值 5s 过短：N 个账号在 20s 内轮换身份是典型风控特征。
// 改为基础 45s ± 20s 随机抖动，打破固定节奏。
const RENEWAL_GAP_BASE_MS = 45000;
const RENEWAL_GAP_JITTER_MS = 20000;

// 仅对「即将过期」的账号做网络续期，其余只做本地检查（减少无谓请求）
const RENEWAL_THRESHOLD_HOURS = 72;

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
// Cookie 有效期本身按天计，原 25 分钟的心跳远超必要且节奏固定，易被标记为机器人。
// 改为「基础值 ± 抖动」，每次触发后重新排期，使实际间隔不可预测。
const RENEWAL_BASE_MIN = 75;
const RENEWAL_JITTER_MIN = 25;        // 实际 50–100 分钟

const SYNC_BASE_MIN = 30;
const SYNC_JITTER_MIN = 8;            // 实际 22–38 分钟

const ALL_RENEWAL_BASE_MIN = 360;
const ALL_RENEWAL_JITTER_MIN = 90;    // 实际 270–450 分钟

// ─── 通知图标（PNG 文件路径，Chrome 通知不支持 SVG base64） ───
const NOTIFICATION_ICON_URL = "icon_notify.png";

// ─── WebDAV 超时（毫秒） ───
const WEBDAV_TIMEOUT_MS = 60000;

// ─── 墓碑清理周期（毫秒） ───
const TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000;

// ─── 隐身容器隔离保活 ───
const COOKIE_STORE_NORMAL = "0";      // 普通窗口（用户当前身份所在）
const TAB_LOAD_TIMEOUT_MS = 25000;    // 等待隐身标签页加载完成的上限
const TAB_SETTLE_MS = 2500;           // 加载完成后额外静置，等异步 XHR 刷新 Cookie
