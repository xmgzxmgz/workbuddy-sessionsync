// lib/util.mjs — 通用工具
import crypto from 'node:crypto';

export const uuid = () => crypto.randomUUID();

export const now = () => Date.now();

/** 读取请求体（带大小限制），返回 Buffer */
export function readBody(req, limitBytes = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 安全解析 JSON，失败返回 null */
export function parseJson(buf) {
  if (!buf || buf.length === 0) return null;
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}

/** 时间安全比较两个秘密字符串 */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** ISO 日期字符串 / 时间戳毫秒 → 毫秒时间戳；无法解析返回 null */
export function toTs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : t;
}

/** 毫秒时间戳 → 本地化显示字符串 */
export function fmtTs(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 简单 JSON 响应 */
export function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 生成上下文片段：截取 token 命中位置附近的文本 */
export function snippet(text, tokens, width = 70) {
  if (!text) return '';
  const plain = String(text);
  const lower = plain.toLowerCase();
  let pos = -1;
  for (const t of tokens) {
    const i = lower.indexOf(t.toLowerCase());
    if (i >= 0 && (pos < 0 || i < pos)) pos = i;
  }
  if (pos < 0) return plain.slice(0, width * 2);
  const start = Math.max(0, pos - width);
  const end = Math.min(plain.length, pos + width);
  return (start > 0 ? '…' : '') + plain.slice(start, end) + (end < plain.length ? '…' : '');
}
