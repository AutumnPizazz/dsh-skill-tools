import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  apply,
  buildIndex,
  discoverSkills,
  frontmatterBoolean,
  matchSkills,
  normalizeText,
  parseFrontmatterBlock,
  presetOf,
  resolveConfig,
  searchSkills,
  splitFrontmatter,
  splitKeywords,
  tokensOf,
} from '../index.mjs';

const SKILL = (frontmatter, body = '正文内容') => `---\n${frontmatter}\n---\n\n${body}\n`;

async function makeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'minimal-skill-'));
  const dirs = [path.join(root, 'skills')];
  await mkdir(path.join(dirs[0], 'alpha'), { recursive: true });
  await writeFile(
    path.join(dirs[0], 'alpha', 'SKILL.md'),
    SKILL("name: alpha\nkeywords: pdf, 文档, 排版\ndescription: 'Alpha 技能：PDF 文档处理'"),
  );
  await mkdir(path.join(dirs[0], 'alpine'), { recursive: true });
  await writeFile(
    path.join(dirs[0], 'alpine', 'SKILL.md'),
    SKILL("name: alpine\nkeywords: 镜像\ndescription: Alpine 容器镜像构建"),
  );
  await mkdir(path.join(dirs[0], 'beta'), { recursive: true });
  await writeFile(
    path.join(dirs[0], 'beta', 'SKILL.md'),
    SKILL('name: beta\ndescription: Beta 用户手动技能\ndisable-model-invocation: true'),
  );
  await mkdir(path.join(dirs[0], 'gamma'), { recursive: true });
  await writeFile(path.join(dirs[0], 'gamma', 'SKILL.md'), SKILL('description: 没有 name 的技能'));
  // 单技能目录布局：dir 自身就是技能目录
  const single = path.join(root, 'single');
  await mkdir(single, { recursive: true });
  await writeFile(path.join(single, 'SKILL.md'), SKILL('name: single\ndescription: 单目录技能'));
  return { root, dirs, single };
}

function fakeCtx(preset) {
  const tools = [];
  const listeners = new Map();
  return {
    tools: { register: (tool, options) => { tools.push(tool); tool._options = options; return () => tools.splice(tools.indexOf(tool), 1); } },
    on: (event, handler) => {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
    },
    get: (service) => {
      if (service !== 'sessionProjections') return undefined;
      if (preset === undefined) return undefined;
      return {
        snapshot: (session, names) => ({ values: names.includes('agentPreset') ? { agentPreset: preset } : {} }),
        stateOf: () => preset,
      };
    },
    _tools: tools,
    _listeners: listeners,
  };
}

test('splitFrontmatter 拆出数据与正文', () => {
  const { data, body } = splitFrontmatter(SKILL("name: demo\ndescription: '带引号的描述'", '# 标题\n内容'));
  assert.equal(data.name, 'demo');
  assert.equal(data.description, '带引号的描述');
  assert.equal(body.trim(), '# 标题\n内容');
  assert.deepEqual(splitFrontmatter('没有 frontmatter').data, {});
});

test('parseFrontmatterBlock 支持块标量与引号', () => {
  const folded = parseFrontmatterBlock('description: >\n  第一行\n  第二行\nname: demo');
  assert.equal(folded.description, '第一行 第二行');
  const literal = parseFrontmatterBlock('description: |\n  a\n  b');
  assert.equal(literal.description, 'a\nb');
  const quoted = parseFrontmatterBlock('name: "a: b"');
  assert.equal(quoted.name, 'a: b');
});

test('frontmatterBoolean 宽松解析', () => {
  assert.equal(frontmatterBoolean('true', false), true);
  assert.equal(frontmatterBoolean('yes', false), true);
  assert.equal(frontmatterBoolean('false', true), false);
  assert.equal(frontmatterBoolean(undefined, true), true);
  assert.equal(frontmatterBoolean('乱写', false), false);
});

test('normalizeText 统一大小写/全角/连接符', () => {
  assert.equal(normalizeText('ＰＤＦ 文档'), 'pdf 文档');
  assert.equal(normalizeText('Code-Review'), 'code review');
  assert.equal(normalizeText('  A__B  '), 'a b');
});

test('tokensOf 汉字 bigram + 英文轻词干', () => {
  // 汉字连续段切成 bigram，单个汉字保持单字
  assert.deepEqual(tokensOf('连接服务器'), ['连接', '接服', '服务', '务器']);
  assert.deepEqual(tokensOf('PDF 文档'), ['文档', 'pdf']);
  assert.deepEqual(tokensOf('调试 bug'), ['调试', 'bug']);
  assert.deepEqual(tokensOf('bugs'), ['bugs', 'bug']);
  assert.deepEqual(tokensOf('rendering'), ['rendering', 'render']);
  // 去重，长词优先
  assert.deepEqual(tokensOf('文档 文档'), ['文档']);
  assert.deepEqual(tokensOf(''), []);
  assert.deepEqual(tokensOf('   '), []);
});

test('splitKeywords 支持中英文分隔符', () => {
  assert.deepEqual(splitKeywords('pdf, 文档、排版；review'), ['pdf', '文档', '排版', 'review']);
  assert.deepEqual(splitKeywords(''), []);
  assert.deepEqual(splitKeywords(undefined), []);
});

test('discoverSkills 支持两种布局、排除 user-only、去重、解析新字段', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const skills = await discoverSkills(fixture.dirs);
  assert.deepEqual(skills.map((skill) => skill.name), ['alpha', 'alpine', 'gamma']);
  assert.equal(skills[0].description, 'Alpha 技能：PDF 文档处理');
  assert.equal(skills[0].keywords, 'pdf, 文档, 排版');

  const withUserOnly = await discoverSkills(fixture.dirs, { includeUserOnly: true });
  assert.deepEqual(withUserOnly.map((skill) => skill.name), ['alpha', 'alpine', 'beta', 'gamma']);

  const single = await discoverSkills([fixture.single]);
  assert.deepEqual(single.map((skill) => skill.name), ['single']);

  const deduped = await discoverSkills([fixture.dirs[0], fixture.dirs[0]]);
  assert.equal(deduped.length, 3);

  assert.deepEqual(await discoverSkills([path.join(fixture.root, 'nope')]), []);
});

test('searchSkills 排序、覆盖率与空查询', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const skills = await discoverSkills(fixture.dirs);
  const index = buildIndex(skills, {});

  const hit = searchSkills(skills, 'pdf', { index });
  assert.equal(hit.approximate, false);
  assert.equal(hit.results[0].skill.name, 'alpha');
  assert.equal(hit.results[0].coverage, 1);

  // 中文 bigram 让「文档处理」和「文档」都能命中
  assert.equal(searchSkills(skills, '文档处理', { index }).results[0].skill.name, 'alpha');

  // 空查询 = 列出全部
  const all = searchSkills(skills, '', { index });
  assert.deepEqual(all.results.map((row) => row.skill.name), ['alpha', 'alpine', 'gamma']);

  // 覆盖率不够 → 只给近似结果或空，不给「置信匹配」
  const weak = searchSkills(skills, '镜像 火星', { index });
  assert.equal(weak.results[0].skill.name, 'alpine');
  assert.equal(weak.approximate, true);
  const nothing = searchSkills(skills, '量子 火星', { index });
  assert.deepEqual(nothing.results, []);
  assert.equal(nothing.approximate, false);

  // matchSkills 兼容旧签名：返回技能对象
  assert.deepEqual(matchSkills(skills, 'pdf', { index }).map((skill) => skill.name), ['alpha']);
  assert.deepEqual(matchSkills(skills, '').length, 3);
});

test('searchSkills 回归：46 条真实查询 + 6 条负例', async () => {
  const corpus = JSON.parse(await readFile(new URL('./corpus.json', import.meta.url), 'utf8'));
  assert.equal(corpus.length, 10);
  const index = buildIndex(corpus, {});
  const { positive: cases } = JSON.parse(await readFile(new URL('./queries.json', import.meta.url), 'utf8'));
  for (const [query, expected] of cases) {
    const { results } = searchSkills(corpus, query, { index });
    assert.equal(results[0]?.skill.name, expected, `查询「${query}」首位应为 ${expected}`);
  }

  for (const query of ['局域网', 'pdf', 'rustdesk', '今天天气怎么样', '帮我订机票']) {
    const { results, approximate } = searchSkills(corpus, query, { index });
    assert.deepEqual(results, [], `负例「${query}」不该命中任何技能`);
    assert.equal(approximate, false);
  }
  // 「docker 容器」只剩一个低覆盖近似线索：允许，但必须打上近似标记
  const loose = searchSkills(corpus, 'docker 容器', { index });
  assert.equal(loose.approximate, true);
});

test('resolveConfig 校验配置', () => {
  const config = resolveConfig({ dirs: ['/tmp/x'], presets: [] });
  assert.deepEqual(config.presets, []);
  assert.equal(config.searchToolName, 'skill_search');
  assert.equal(config.minCoverage, 0.5);
  assert.equal(config.approxMinCoverage, 0.25);
  assert.throws(() => resolveConfig({ unknown: 1 }), /unknown config key/);
  assert.throws(() => resolveConfig({ dirs: [] }), /non-empty array/);
  assert.throws(() => resolveConfig({ searchToolName: 'x', loadToolName: 'x' }), /must differ/);
  assert.throws(() => resolveConfig({ maxResults: 0 }), /positive integer/);
  assert.throws(() => resolveConfig({ minCoverage: 1.5 }), /within 0\.\.1/);
  assert.throws(() => resolveConfig({ bodyIndexChars: -1 }), /non-negative integer/);
  assert.equal(resolveConfig({ dirs: ['~/skills'] }).dirs[0], path.join(process.env.HOME, 'skills'));
});

test('apply 注册两个工具并实现搜索/加载', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const ctx = fakeCtx('minimal');
  const state = await apply(ctx, { dirs: fixture.dirs, presets: ['minimal'] });
  assert.equal(state, undefined);
  assert.deepEqual(ctx._tools.map((tool) => tool.name), ['skill_search', 'skill_load']);

  const [search, load] = ctx._tools;

  const hit = await search.execute({ query: 'pdf' }, {});
  assert.match(hit.text, /匹配到 1 个技能（按相关度）/);
  assert.match(hit.text, /- alpha: Alpha 技能：PDF 文档处理/);
  assert.doesNotMatch(hit.text, /正文内容/);

  // 无命中：只列技能名，不铺描述
  const miss = await search.execute({ query: 'zzz' }, {});
  assert.match(miss.text, /没有匹配 "zzz" 的技能/);
  assert.match(miss.text, /可用技能：alpha, alpine, gamma/);
  assert.doesNotMatch(miss.text, /- gamma/);

  const empty = await search.execute({}, {});
  assert.match(empty.text, /全部技能（3）/);

  // 显式列目录不截断（maxResults 只管检索结果）
  const limited = fakeCtx('minimal');
  await apply(limited, { dirs: fixture.dirs, presets: ['minimal'], maxResults: 1 });
  const listAll = await limited._tools[0].execute({}, {});
  assert.match(listAll.text, /全部技能（3）:/);
  assert.equal(listAll.text.split('\n').filter((line) => line.startsWith('- ')).length, 3);

  const loaded = await load.execute({ name: 'alpha' }, {});
  assert.match(loaded.text, /技能 alpha（目录：/);
  assert.match(loaded.text, /正文内容/);
  assert.doesNotMatch(loaded.text, /---/);

  // 大小写 + 唯一部分匹配都能直接加载
  assert.match((await load.execute({ name: 'ALPHA' }, {})).text, /正文内容/);
  assert.match((await load.execute({ name: 'gam' }, {})).text, /技能 gamma/);

  // 多个部分匹配 → 报歧义并列出候选
  const ambiguous = await load.execute({ name: 'alp' }, {});
  assert.match(ambiguous.text, /有歧义/);
  assert.match(ambiguous.text, /alpha, alpine/);

  const missing = await load.execute({ name: 'nope' }, {});
  assert.match(missing.text, /没有名为 "nope" 的技能/);
  assert.match(missing.text, /alpha, alpine, gamma/);

  const blank = await load.execute({ name: '  ' }, {});
  assert.match(blank.text, /非空的 name/);

  assert.deepEqual(ctx._tools[0].output.render({}, { text: 'hi' }), [{ type: 'text', text: 'hi' }]);
  assert.equal(ctx._tools[0].parameters.additionalProperties, false);
});

test('apply 在空目录/坏配置下不抛异常', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'minimal-skill-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const ctx = fakeCtx(undefined);
  await apply(ctx, { dirs: [root] });
  const [search, load] = ctx._tools;
  assert.match((await search.execute({ query: 'x' })).text, /找到任何技能/);
  assert.match((await load.execute({ name: 'x' })).text, /可用技能：\(空\)/);

  const brokenCtx = fakeCtx('minimal');
  await assert.rejects(() => apply(brokenCtx, { dirs: [] }));
});

test('apply 注册失败时明确报错，不能只注册一半', async () => {
  let disposed = false;
  let count = 0;
  const ctx = { tools: { register: () => {
    if (++count === 2) throw new Error('duplicate tool name');
    return () => { disposed = true; };
  } }, on: () => {}, get: () => undefined };
  await assert.rejects(() => apply(ctx, { dirs: ['/tmp'] }), /duplicate tool name/);
  assert.equal(disposed, true);
});

test('presetOf 与正式工具激活条件', async () => {
  assert.equal(presetOf(fakeCtx('minimal'), { session: {} }), 'minimal');
  // 只有 stateOf 的注册表（老形态）也能读
  const stateOnly = { get: () => ({ stateOf: () => 'minimal' }) };
  assert.equal(presetOf(stateOnly, { session: {} }), 'minimal');
  // snapshot 报空 → 退回 stateOf
  const emptySnapshot = { get: () => ({ snapshot: () => ({ values: {} }), stateOf: () => 'minimal' }) };
  assert.equal(presetOf(emptySnapshot, { session: {} }), 'minimal');
  assert.equal(presetOf({ get: () => ({ snapshot: () => null }) }, { session: {} }), undefined);
  assert.equal(presetOf(fakeCtx(undefined), { session: {} }), undefined);
  assert.equal(presetOf({ get: () => undefined }, { session: {} }), undefined);
  assert.equal(presetOf(fakeCtx('minimal'), undefined), undefined);

  for (const [id, expected] of [['minimal', true], ['standard', false], [undefined, true]]) {
    const ctx = fakeCtx(id);
    await apply(ctx, { dirs: ['/tmp'], presets: ['minimal'] });
    assert.equal(ctx._tools[0]._options.when({ agent: { session: {} } }), expected);
    assert.equal(ctx._listeners.has('system-prompt/assemble'), false);
  }
});

test('空查询提示遵循自定义加载工具名', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const ctx = fakeCtx('minimal');
  await apply(ctx, { dirs: fixture.dirs, loadToolName: 'load_local_skill' });
  const result = await ctx._tools.find((tool) => tool.name === 'skill_search').execute({});
  assert.match(result.text, /用 load_local_skill 读取正文/);
});

test('真实技能文档的 46 条查询、元数据与正文加载', { skip: !process.env.DSH_SKILL_TEST_DIR }, async () => {
  const dir = path.resolve(process.env.DSH_SKILL_TEST_DIR);
  const skills = await discoverSkills([dir]);
  assert.equal(skills.length, 10);
  const { positive } = JSON.parse(await readFile(new URL('./queries.json', import.meta.url), 'utf8'));
  const index = buildIndex(skills);
  for (const [query, expected] of positive) {
    assert.equal(searchSkills(skills, query, { index }).results[0]?.skill.name, expected, query);
  }
  const ctx = fakeCtx('minimal');
  await apply(ctx, { dirs: [dir] });
  const loader = ctx._tools.find((tool) => tool.name === 'skill_load');
  for (const skill of skills) {
    assert.ok(skill.description && skill.keywords, skill.name);
    const loaded = await loader.execute({ name: skill.name });
    assert.ok(loaded.text.endsWith(skill.body.trim()), skill.name);
    assert.ok(loaded.text.startsWith(`技能 ${skill.name}（目录：`), skill.name);
  }
});

test('新增、修改和删除技能在下一次调用立即可见', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const ctx = fakeCtx('minimal');
  await apply(ctx, { dirs: fixture.dirs });
  const search = ctx._tools.find((tool) => tool.name === 'skill_search');
  const load = ctx._tools.find((tool) => tool.name === 'skill_load');
  const dir = path.join(fixture.dirs[0], 'delta');
  await mkdir(dir);
  await writeFile(path.join(dir, 'SKILL.md'), SKILL('name: delta\nkeywords: delta\ndescription: 新技能', '第一版'));
  assert.match((await search.execute({ query: 'delta' })).text, /delta/);
  assert.match((await load.execute({ name: 'delta' })).text, /第一版/);
  await writeFile(path.join(dir, 'SKILL.md'), SKILL('name: delta\nkeywords: delta\ndescription: 更新技能', '第二版'));
  assert.match((await search.execute({ query: 'delta' })).text, /更新技能/);
  assert.match((await load.execute({ name: 'delta' })).text, /第二版/);
  await rm(dir, { recursive: true });
  assert.match((await load.execute({ name: 'delta' })).text, /没有名为 "delta" 的技能/);
  assert.doesNotMatch((await search.execute({ query: '' })).text, /delta/);
});
