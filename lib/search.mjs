// lib/search.mjs — 中文友好分词 + 内存倒排索引
//
// 分词策略：ASCII 连续字母数字串作为一个词（小写化）；
// CJK 连续片段切成二元词组（bigram），单字片段保留单字。
// 中文子串检索（如搜"同步机制"命中"同步机制设计"）依赖 bigram 的连续命中加权。

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]+/g;
const WORD_RE = /[a-z0-9_\-]+/g;

/** 分词：返回 token 数组 */
export function tokenize(text) {
  if (!text) return [];
  const out = [];
  const pushWord = (w) => {
    if (w.length >= 1 && w.length <= 64) out.push(w);
  };
  let last = 0;
  const s = String(text);
  const lower = s.toLowerCase();
  for (const m of s.matchAll(CJK_RE)) {
    // 先收词区间前的 ASCII 词
    collectAscii(lower.slice(last, m.index), pushWord);
    const run = m[0];
    if (run.length === 1) pushWord(run);
    else for (let i = 0; i < run.length - 1; i++) pushWord(run.slice(i, i + 2));
    last = m.index + run.length;
  }
  collectAscii(lower.slice(last), pushWord);
  return out;
}

function collectAscii(seg, push) {
  for (const m of seg.matchAll(WORD_RE)) push(m[0]);
}

// 索引结构：
//   postings: Map<token, Map<entityKey, weight>>   token → 实体 → 权重(含词频)
//   entityTokens: Map<entityKey, Map<token, weight>>  实体 → 已建索引 token（用于移除）
export class SearchIndex {
  constructor() {
    this.postings = new Map();
    this.entityTokens = new Map();
  }

  /** 为实体建索引。weights: [{text, weight}] 多字段加权 */
  index(entityKey, fields) {
    this.remove(entityKey);
    const tokens = tokenize(fields.map((f) => f.text).join('\n'));
    if (!tokens.length) return;
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    const myTokens = new Map();
    for (const [t, n] of tf) {
      const w = n * (fields[0].weight || 1); // 词频 × 主字段权重（简化：取传入主权重）
      myTokens.set(t, w);
      let p = this.postings.get(t);
      if (!p) {
        p = new Map();
        this.postings.set(t, p);
      }
      p.set(entityKey, w);
    }
    this.entityTokens.set(entityKey, myTokens);
  }

  /** 为实体的多个字段分别建索引并求和（标题权重高于正文） */
  indexFields(entityKey, fieldList) {
    this.remove(entityKey);
    const myTokens = new Map();
    for (const { text, weight } of fieldList) {
      const toks = tokenize(text);
      if (!toks.length) continue;
      const tf = new Map();
      for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
      for (const [t, n] of tf) {
        const w = n * weight;
        myTokens.set(t, (myTokens.get(t) || 0) + w);
      }
    }
    for (const [t, w] of myTokens) {
      let p = this.postings.get(t);
      if (!p) {
        p = new Map();
        this.postings.set(t, p);
      }
      p.set(entityKey, w);
    }
    this.entityTokens.set(entityKey, myTokens);
  }

  remove(entityKey) {
    const myTokens = this.entityTokens.get(entityKey);
    if (!myTokens) return;
    for (const t of myTokens.keys()) {
      const p = this.postings.get(t);
      if (p) {
        p.delete(entityKey);
        if (p.size === 0) this.postings.delete(t);
      }
    }
    this.entityTokens.delete(entityKey);
  }

  /**
   * 查询：返回 [entityKey, score] 按得分降序。
   * 得分 = 覆盖率（命中的查询 token 比例，主导）× Σ(命中 token 权重)。
   */
  query(text) {
    const qTokens = [...new Set(tokenize(text))];
    if (!qTokens.length) return [];
    const acc = new Map(); // entityKey -> {hit: Set, score}
    for (const t of qTokens) {
      const p = this.postings.get(t);
      if (!p) continue;
      for (const [key, w] of p) {
        let e = acc.get(key);
        if (!e) {
          e = { hit: 0, score: 0 };
          acc.set(key, e);
        }
        e.hit += 1;
        e.score += w;
      }
    }
    const results = [];
    for (const [key, e] of acc) {
      const coverage = e.hit / qTokens.length;
      results.push([key, coverage * (1 + Math.log(1 + e.score))]);
    }
    results.sort((a, b) => b[1] - a[1]);
    return results;
  }

  /** 关键词粗筛（无倒排时的兜底子串匹配） */
  static substringMatch(haystack, q) {
    if (!q) return true;
    return String(haystack || '').toLowerCase().includes(String(q).toLowerCase());
  }
}
