// ============================================================================
// 敏感信息加密
//
// 关于「单向加密」的说明（重要）：
//   用户的 API Key 必须能被**还原**后才能拿去调用上游模型。
//   单向散列（SHA-256/bcrypt 之类）是不可逆的，用它存 API Key 等于把 Key 丢掉，
//   业务上根本用不了。所以这里用**可逆的对称加密**：
//
//     AES-256-GCM（带认证的加密）
//     · 机密性：密钥由 APP_MASTER_KEY 派生，数据库泄漏也读不到明文
//     · 完整性：GCM 的认证标签可检测密文被篡改
//     · 每次加密使用独立随机 IV，相同明文产生不同密文
//
//   真正适合单向散列的是「只需校验、无需还原」的东西，例如 Webhook 密钥。
//   本文件同时提供 hashSecret / timingSafeEqual 用于那类场景。
// ============================================================================
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { config } from "./config.js";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;   // GCM 推荐 96 bit
const TAG_LEN = 16; // GCM 认证标签固定 128 bit
const VERSION = "v1";

/** 把 APP_MASTER_KEY 规整成 32 字节密钥 */
function deriveMasterKey(source) {
  const s = String(source).trim();
  // 64 位十六进制 → 直接当 32 字节用
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, "hex");
  // 其他情况统一用 SHA-256 派生，保证长度正确且不丢失熵
  return createHash("sha256").update(s, "utf8").digest();
}

export const masterKey = deriveMasterKey(config.masterKeySource);
export const masterKeyFingerprint = createHash("sha256")
  .update(masterKey)
  .digest("hex")
  .slice(0, 12);

/**
 * 加密任意字符串，输出可安全存入 TEXT 列的紧凑格式：
 *   v1:<iv_b64>:<tag_b64>:<ciphertext_b64>
 */
export function encryptSecret(plaintext) {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, masterKey, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

/**
 * 解密。密文被篡改、格式错误或密钥不匹配时抛错，
 * 调用方应捕获并把该用户的 AI 配置视为不可用，而不是崩溃。
 */
export function decryptSecret(payload) {
  const parts = String(payload || "").split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("密文格式不正确");
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  // 显式校验长度，避免把畸形输入送进解密器
  // （GCM 的 IV 必须 12 字节、认证标签必须 16 字节）
  if (iv.length !== IV_LEN) throw new Error("密文 IV 长度不正确");
  if (tag.length !== TAG_LEN) throw new Error("密文认证标签长度不正确");

  const decipher = createDecipheriv(ALGO, masterKey, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** 解密失败时返回 null 而不抛错 */
export function tryDecryptSecret(payload) {
  try {
    return decryptSecret(payload);
  } catch {
    return null;
  }
}

// ─── 单向散列：仅用于「只需校验、无需还原」的场景 ──────────────────────────

/** 加盐 SHA-256，用于校验型密钥 */
export function hashSecret(plaintext, salt = "nodeseek-monitor") {
  return createHash("sha256").update(`${salt}:${plaintext}`, "utf8").digest("hex");
}

/** 常量时间比较，避免时序侧信道 */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** 生成给用户看的指纹，便于确认「用的是哪把 Key」而不泄漏 Key 本身 */
export function keyFingerprint(apiKey) {
  return createHash("sha256").update(String(apiKey), "utf8").digest("hex").slice(0, 8);
}

/** 打码展示：sk-abcd…wxyz */
export function maskSecret(apiKey) {
  const s = String(apiKey || "");
  if (s.length <= 10) return "****";
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}
