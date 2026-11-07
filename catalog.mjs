/** 配置、技能元数据解析与目录发现；每次读取磁盘，不缓存。 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const DEFAULT_CONFIG = Object.freeze({
  /** 技能根目录；支持 `<dir>/<skill>/SKILL.md` 与 `<dir>/SKILL.md` 两种布局。 */
  dirs: ['~/.dsh/skills'],
  /** 只在这些 agent preset 里露出工具；空数组 = 所有 preset 都露出。 */
  presets: [],
  /** 原有技能工具名，仅在对应 agent 作用域中替换。 */
  replaceTools: ['skill'],
  /** auto 合并原生服务和目录，filesystem 只读目录，registry 只用原生服务。 */
  catalogSource: 'auto',
  /** 搜索工具名。 */
  searchToolName: 'skill_search',
  /** 加载工具名。 */
  loadToolName: 'skill_load',
  /** 是否把 `disable-model-invocation: true` 的技能也纳入搜索（默认排除）。 */
  includeUserOnly: false,
  /** 单次搜索最多返回条数。 */
  maxResults: 8,
  /** skill_load 返回正文的最大字符数，超出截断并提示。 */
  maxBodyChars: 60000,
  /** 置信命中所需的最小覆盖率（命中 token 权重 / 查询 token 总权重），0..1。 */
  minCoverage: 0.5,
  /** 相对分阈值：低于「最佳分 × 该值」的结果丢弃。 */
  scoreRatio: 0.3,
  /** 近似结果的最低覆盖率：不够就连近似也不给，直接回技能名列表，免得噪声误导。 */
  approxMinCoverage: 0.25,
  /** 正文参与检索的字符数，0 = 不索引正文。 */
  bodyIndexChars: 2000,
});

const SKILL_FILE = 'SKILL.md';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function expandHome(input) {
  const text = String(input ?? '').trim();
  if (text === '~') return homedir();
  if (text.startsWith('~/')) return path.join(homedir(), text.slice(2));
  return path.resolve(text);
}

/** 归一化并校验配置，未知键/类型错误直接抛（启动时就能发现写错的字段）。 */
export function resolveConfig(raw) {
  const input = raw === undefined || raw === null ? {} : raw;
  if (!isPlainObject(input)) {
    throw new TypeError('dsh-skill-tools: config must be an object');
  }
  const config = { ...DEFAULT_CONFIG };
  for (const [key, value] of Object.entries(input)) {
    if (!(key in DEFAULT_CONFIG)) {
      throw new TypeError(`dsh-skill-tools: unknown config key "${key}"`);
    }
    config[key] = value;
  }
  if (!Array.isArray(config.dirs) || config.dirs.length === 0) {
    throw new TypeError('dsh-skill-tools: "dirs" must be a non-empty array of paths');
  }
  config.dirs = config.dirs.map(expandHome).filter(Boolean);
  if (!Array.isArray(config.presets)) {
    throw new TypeError('dsh-skill-tools: "presets" must be an array of preset ids');
  }
  config.presets = config.presets.map((item) => String(item).trim()).filter(Boolean);
  for (const key of ['searchToolName', 'loadToolName']) {
    if (typeof config[key] !== 'string' || config[key].trim() === '') {
      throw new TypeError(`dsh-skill-tools: "${key}" must be a non-empty string`);
    }
    config[key] = config[key].trim();
  }
  if (config.searchToolName === config.loadToolName) {
    throw new TypeError('dsh-skill-tools: searchToolName and loadToolName must differ');
  }
  if (!Array.isArray(config.replaceTools) || config.replaceTools.some(name =>
      typeof name !== 'string' || !name.trim() ||
      ['run_code', config.searchToolName, config.loadToolName].includes(name.trim()))) {
    throw new TypeError('dsh-skill-tools: "replaceTools" must contain only old skill tool names');
  }
  config.replaceTools = [...new Set(config.replaceTools.map(name => name.trim()))];
  if (!['auto', 'filesystem', 'registry'].includes(config.catalogSource)) {
    throw new TypeError('dsh-skill-tools: "catalogSource" must be auto, filesystem, or registry');
  }
  if ([config.searchToolName, config.loadToolName].includes('run_code')) {
    throw new TypeError('dsh-skill-tools: run_code is a reserved tool name');
  }
  if (typeof config.includeUserOnly !== 'boolean') {
    throw new TypeError('dsh-skill-tools: "includeUserOnly" must be a boolean');
  }
  for (const key of ['maxResults', 'maxBodyChars']) {
    if (!Number.isInteger(config[key]) || config[key] <= 0) {
      throw new TypeError(`dsh-skill-tools: "${key}" must be a positive integer`);
    }
  }
  if (!Number.isInteger(config.bodyIndexChars) || config.bodyIndexChars < 0) {
    throw new TypeError('dsh-skill-tools: "bodyIndexChars" must be a non-negative integer');
  }
  for (const key of ['minCoverage', 'scoreRatio', 'approxMinCoverage']) {
    if (typeof config[key] !== 'number' || Number.isNaN(config[key]) || config[key] < 0 || config[key] > 1) {
      throw new TypeError(`dsh-skill-tools: "${key}" must be a number within 0..1`);
    }
  }
  return config;
}

/** 拆出 frontmatter 与正文；不依赖 YAML 库，只认得技能文件实际会用到的子集。 */
export function splitFrontmatter(text) {
  const source = String(text ?? '');
  if (!source.startsWith('---')) return { data: {}, body: source };
  const end = source.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: source };
  const head = source.slice(source.indexOf('\n', 3) + 1, end);
  const bodyStart = source.indexOf('\n', end + 1);
  const body = bodyStart === -1 ? '' : source.slice(bodyStart + 1);
  return { data: parseFrontmatterBlock(head), body };
}

function unquote(value) {
  const text = value.trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return text.slice(1, -1);
    }
  }
  return text;
}

function stripIndent(lines) {
  const indents = lines
    .filter((line) => line.trim() !== '')
    .map((line) => line.match(/^ */)[0].length);
  const min = indents.length === 0 ? 0 : Math.min(...indents);
  return lines.map((line) => line.slice(Math.min(min, line.length)));
}

/** 解析 `key: value` 的扁平 YAML 子集，支持引号与 `|` / `>` 块标量。 */
export function parseFrontmatterBlock(head) {
  const data = {};
  const lines = String(head ?? '').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const match = line.match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const rawValue = match[2];
    const blockMatch = rawValue.match(/^([|>])([+-]?)$/);
    if (blockMatch) {
      const blockLines = [];
      while (index + 1 < lines.length) {
        const next = lines[index + 1];
        if (next.trim() !== '' && !next.startsWith(' ') && !next.startsWith('\t')) break;
        blockLines.push(next);
        index += 1;
      }
      while (blockLines.length > 0 && blockLines[blockLines.length - 1].trim() === '') {
        blockLines.pop();
      }
      const stripped = stripIndent(blockLines);
      data[key] =
        blockMatch[1] === '|' ? stripped.join('\n').trim() : stripped.map((item) => item.trim()).filter(Boolean).join(' ');
      continue;
    }
    data[key] = unquote(rawValue);
  }
  return data;
}

/** 宽松的布尔解析：true/yes/on/1 为真，false/no/off/0 为假，其它走 fallback。 */
export function frontmatterBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return fallback;
  const text = value.trim().toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(text)) return true;
  if (['false', 'no', 'off', '0'].includes(text)) return false;
  return fallback;
}

async function isDirectory(target) {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function readSkillFrom(dir, skillName) {
  const file = path.join(dir, SKILL_FILE);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  const { data, body } = splitFrontmatter(text);
  return {
    name: String(data.name ?? skillName).trim() || skillName,
    description: oneLine(data.description ?? ''),
    whenToUse: oneLine(data.whenToUse ?? ''),
    keywords: data.keywords === undefined ? '' : String(data.keywords),
    dir,
    file,
    body,
    userOnly: frontmatterBoolean(data['disable-model-invocation'], false),
    source: data.source === undefined ? '' : String(data.source),
  };
}

/** 扫描目录，按 dirs 顺序收集技能，同名以先出现的为准。 */
export async function discoverSkills(dirs, options = {}) {
  const includeUserOnly = options.includeUserOnly === true;
  const found = new Map();
  for (const dir of dirs) {
    if (!(await isDirectory(dir))) continue;
    // 布局一：dir 本身就是技能目录（自身带 SKILL.md）
    const self = await readSkillFrom(dir, path.basename(dir));
    if (self) {
      if ((includeUserOnly || !self.userOnly) && !found.has(self.name)) found.set(self.name, self);
      continue;
    }
    // 布局二：dir 下每个子目录是一个技能
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillDir = path.join(dir, entry.name);
      if (!(await isDirectory(skillDir))) continue;
      const skill = await readSkillFrom(skillDir, entry.name);
      if (!skill) continue;
      if (!includeUserOnly && skill.userOnly) continue;
      if (found.has(skill.name)) continue;
      found.set(skill.name, skill);
    }
  }
  return [...found.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/** 归一化：NFKC（全角转半角）、小写、下划线/连字符当分隔符、压空白。 */
function oneLine(text, limit = 200) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}
