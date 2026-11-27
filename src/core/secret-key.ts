import * as crypto from 'crypto';
import * as fs from 'fs';

/**
 * Secret Key：与口令并行的第二个因子。
 *
 * 形态（28 字符）：26 字符载荷（128 位随机，base32）+ 2 字符校验（CRC16 低 10 位）。
 * - 字母表去掉了 0/O/1/I，抄写时不会混；
 * - 校验位让录入错误当场就能发现，而不是等到「解锁失败」；
 * - 显示按 4 组 × 7 分组，符合 28 字符的唯一整齐切法。
 *
 * 本文件只做「生成 / 规范化 / 校验 / 解码」，不碰加密与存储；
 * 派生在 vault 里（deriveWithSk），因为要复用 keystore 的 salt 与迭代次数。
 */

/** 去掉易混字符（0/O/1/I）的 base32 字母表，顺序固定，改动等于换编码 */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** 载荷字符数：128 位 / 5 bit = 25.6 → 26（末尾 2 bit 补 0） */
const PAYLOAD_LEN = 26;
/** 校验字符数 */
const CHECK_LEN = 2;
/** 完整长度 */
export const SECRET_KEY_LEN = PAYLOAD_LEN + CHECK_LEN;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** 解出前 26 字符对应的 128 位；尾部的填充位丢弃 */
export function base32Decode(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`非法 Secret Key 字符：${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** CRC16-CCITT：用于 2 字符校验位 */
export function crc16(s: string): number {
  let crc = 0xffff;
  for (let i = 0; i < s.length; i += 1) {
    crc ^= s.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function checkChars(payload: string): string {
  const c = crc16(payload);
  return ALPHABET[(c >>> 5) & 31] + ALPHABET[c & 31];
}

/** 规范化：大写、去掉空格 / 连字符 / 其它分隔符（用户从应急包手抄时常常带分隔） */
export function normalizeSecretKey(raw: string): string {
  return String(raw || '')
    .toUpperCase()
    .replace(/[\s-]+/g, '');
}

/** 显示格式：4 组 × 7 */
export function formatSecretKey(raw: string): string {
  const s = normalizeSecretKey(raw);
  return s.match(/.{1,7}/g)?.join('-') || s;
}

/** 生成一把新的 Secret Key；hint 是末 4 位，用于「是不是同一把」的辨认 */
export function generateSecretKey(): { secretKey: string; hint: string } {
  const payload = base32Encode(crypto.randomBytes(16));
  const raw = payload + checkChars(payload);
  return { secretKey: formatSecretKey(raw), hint: raw.slice(-4) };
}

/** 校验格式与校验位（不判断「是否属于某个库」，那要靠 keystore 的 hint/指纹） */
export function isValidSecretKey(raw: string): boolean {
  const s = normalizeSecretKey(raw);
  if (s.length !== SECRET_KEY_LEN) return false;
  if (![...s].every((c) => ALPHABET.includes(c))) return false;
  const payload = s.slice(0, PAYLOAD_LEN);
  return s.slice(PAYLOAD_LEN) === checkChars(payload);
}

/** 取末 4 位（用于界面显示「••••-ABCD」） */
export function secretKeyHint(raw: string): string {
  return normalizeSecretKey(raw).slice(-4);
}

/** 解码为 16 字节（128 位），供派生使用 */
export function decodeSecretKey(raw: string): Buffer {
  const s = normalizeSecretKey(raw);
  if (!isValidSecretKey(s)) throw new Error('Secret Key 格式或校验位不正确');
  return base32Decode(s.slice(0, PAYLOAD_LEN)).subarray(0, 16);
}

/**
 * 解析配置里的 Secret Key 来源。
 * - `VAULT_SECRET_KEY=K7M2...`：直接给值（会写进 Agent 配置，不推荐）；
 * - `VAULT_SECRET_KEY=@file:~/.flintkeep/secret_key.txt`：从文件读，避免明文进配置。
 * 返回 null 表示「没配置或读不出来」，调用方按缺 SK 处理，不要静默当成空串。
 */
export function resolveSecretKeySource(raw: string | undefined, home?: string): string | null {
  const v = String(raw || '').trim();
  if (!v) return null;
  const m = /^@(?:file:)?(.+)$/.exec(v);
  if (!m) return v;
  try {
    const path = m[1].replace(/^~(?=\/)/, home || process.env.HOME || '');
    const text = fs.readFileSync(path, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const s = normalizeSecretKey(line);
      if (s && isValidSecretKey(s)) return s;
    }
    return null;
  } catch {
    return null;
  }
}
