/** 中文 bigram / 英文轻词干检索，保留字段权重、IDF 与覆盖率规则。 */
import { DEFAULT_CONFIG } from './catalog.mjs';

export const FIELD_WEIGHTS = Object.freeze({ name: 8, keywords: 6, whenToUse: 4, description: 3, body: 1 });
const APPROX_MIN_SCORE = 0.05;

export function normalizeText(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const EN_STEM_SUFFIXES = ['ing', 'ed', 'es', 's'];

/**
 * 中英文都能切词：
 *   - 汉字连续段切二元组（bigram），单字段落保留本身
 *   - 英文/数字按词切，保留原形并追加轻词干（bugs → bug、reviewing → review）
 * 二元组让「连接服务器」能命中「连接复用」「服务器」这类分散写法；
 * 老实现把整段汉字当一个 token，必须原文整段出现，实际永远搜不到。
 */
export function tokensOf(query) {
  const text = normalizeText(query);
  const out = [];
  const seen = new Set();
  const push = (token) => {
    if (token && !seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  };
  for (const run of text.match(/[\p{Script=Han}]+/gu) ?? []) {
    if (run.length === 1) {
      push(run);
      continue;
    }
    for (let index = 0; index + 1 < run.length; index += 1) push(run.slice(index, index + 2));
  }
  for (const word of text.match(/[a-z0-9][a-z0-9.+#]*/g) ?? []) {
    push(word);
    for (const suffix of EN_STEM_SUFFIXES) {
      if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
        push(word.slice(0, -suffix.length));
        break;
      }
    }
  }
  return out;
}

/** keywords 字段允许逗号/顿号/分号/换行分隔。 */
export function splitKeywords(keywords) {
  return String(keywords ?? '')
    .split(/[,，、;；\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 单个技能的可检索字段文本。 */
function fieldTexts(skill, bodyIndexChars) {
  const body = Number.isInteger(bodyIndexChars) && bodyIndexChars > 0 ? String(skill.body ?? '').slice(0, bodyIndexChars) : '';
  return {
    name: `${skill.name} ${String(skill.name ?? '').replace(/[-_]+/g, ' ')}`,
    keywords: splitKeywords(skill.keywords).join(' '),
    whenToUse: String(skill.whenToUse ?? ''),
    description: String(skill.description ?? ''),
    body,
  };
}

/** 预建索引：每个技能的每个字段都归一化一次。 */
export function buildIndex(skills, options = {}) {
  const bodyIndexChars = options.bodyIndexChars ?? DEFAULT_CONFIG.bodyIndexChars;
  return skills.map((skill) => {
    const raw = fieldTexts(skill, bodyIndexChars);
    const fields = {};
    for (const field of Object.keys(FIELD_WEIGHTS)) fields[field] = normalizeText(raw[field]);
    return { skill, fields };
  });
}

/**
 * 打分检索。返回 `{ results, approximate }`：
 *   results      —— 按分数降序的 `{ skill, score, coverage, hits }`
 *   approximate  —— true 表示没有达到置信覆盖率，结果只是近似
 * 查询为空时返回全部技能（score 0），由调用方决定怎么展示。
 */
export function searchSkills(skills, query, options = {}) {
  const maxResults = options.maxResults ?? DEFAULT_CONFIG.maxResults;
  const minCoverage = options.minCoverage ?? DEFAULT_CONFIG.minCoverage;
  const scoreRatio = options.scoreRatio ?? DEFAULT_CONFIG.scoreRatio;
  const tokens = tokensOf(query);
  if (tokens.length === 0) {
    return { results: skills.slice(0, maxResults).map((skill) => ({ skill, score: 0, coverage: 0, hits: [] })), approximate: false };
  }
  const indexed = options.index ?? buildIndex(skills, options);
  const total = indexed.length || 1;
  const documentFrequency = new Map();
  for (const token of tokens) {
    let count = 0;
    for (const { fields } of indexed) {
      for (const field of Object.keys(FIELD_WEIGHTS)) {
        if (fields[field].includes(token)) {
          count += 1;
          break;
        }
      }
    }
    documentFrequency.set(token, count);
  }
  const phrase = normalizeText(query);
  const rows = [];
  for (const { skill, fields } of indexed) {
    let scoreSum = 0;
    let weightSum = 0;
    let hitWeight = 0;
    let bestField = 0;
    const hits = [];
    for (const token of tokens) {
      const idf = Math.log(1 + total / (1 + (documentFrequency.get(token) ?? 0)));
      weightSum += idf;
      let fieldWeight = 0;
      for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
        if (weight > fieldWeight && fields[field].includes(token)) fieldWeight = weight;
      }
      if (fieldWeight > 0) {
        hitWeight += idf;
        hits.push(token);
      }
      scoreSum += idf * fieldWeight;
      bestField = Math.max(bestField, fieldWeight);
    }
    if (bestField === 0) continue;
    let score = weightSum > 0 ? scoreSum / (weightSum * FIELD_WEIGHTS.name) : 0;
    if (phrase.length >= 2) {
      if (fields.name.includes(phrase)) score += 0.35;
      else if (fields.keywords.includes(phrase)) score += 0.15;
    }
    rows.push({ skill, score, coverage: weightSum > 0 ? hitWeight / weightSum : 0, hits });
  }
  rows.sort((left, right) => right.score - left.score || right.coverage - left.coverage || left.skill.name.localeCompare(right.skill.name));
  if (rows.length === 0) return { results: [], approximate: false };
  const floor = rows[0].score * scoreRatio;
  const kept = rows.filter((row) => row.score >= floor);
  const confident = kept.filter((row) => row.coverage >= minCoverage);
  if (confident.length > 0) return { results: confident.slice(0, maxResults), approximate: false };
  const approxMinCoverage = options.approxMinCoverage ?? DEFAULT_CONFIG.approxMinCoverage;
  const loose = kept.filter((row) => row.coverage >= approxMinCoverage && row.score >= APPROX_MIN_SCORE);
  return { results: loose.slice(0, Math.min(maxResults, 3)), approximate: loose.length > 0 };
}

/** 只需要技能对象时使用的检索入口。 */
export function matchSkills(skills, query, options = {}) {
  return searchSkills(skills, query, options).results.map((row) => row.skill);
}
