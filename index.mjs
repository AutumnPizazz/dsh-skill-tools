/** dsh 按需技能工具；配置与发现见 catalog.mjs，检索见 search.mjs。 */
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { discoverSkills, expandHome, resolveConfig } from './catalog.mjs';
import { buildIndex, searchSkills } from './search.mjs';
export * from './catalog.mjs';
export * from './search.mjs';
export { presetOf } from './presets.mjs';
import { installPresetTools, presetEnabled } from './presets.mjs';
import { openCatalog } from './providers.mjs';

export const name = 'skill-tools';
export const inject = ['tools'];

function textResult(text) {
  return { text };
}

/** 空查询：列出全部技能名 + 一行描述（显式要目录就不截断，技能库是几十条量级）。 */
function formatList(skills, loadToolName) {
  const lines = [`全部技能（${skills.length}）:`];
  for (const skill of skills) lines.push(`- ${skill.name}: ${skill.description || '(无 description)'}`);
  lines.push('', `用 ${loadToolName} 读取正文。`);
  return lines.join('\n');
}

/** 有命中：只给名字 + 一行描述，按分数排序。 */
function formatResults(results, options) {
  const lines = [];
  if (options.approximate) {
    lines.push('没有高置信匹配，下面是按相关度排的近似结果（可能不相关）：');
  } else {
    lines.push(`匹配到 ${results.length} 个技能（按相关度）:`);
  }
  for (const { skill } of results) {
    lines.push(`- ${skill.name}: ${skill.description || '(无 description)'}`);
  }
  if (results.length === 1) {
    lines.push('', `用 ${options.loadToolName}({"name": "${results[0].skill.name}"}) 读取正文。`);
  } else {
    lines.push('', `用 ${options.loadToolName} 读取正文，name 取上面的技能名。`);
  }
  return lines.join('\n');
}

function toolParameters(searchToolName) {
  return {
    search: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，空格分隔；中英文都行，中文按字匹配不用整词。留空表示列出全部技能。' },
      },
      required: [],
      additionalProperties: false,
    },
    load: {
      type: 'object',
      properties: {
        name: { type: 'string', description: `技能名，取自 ${searchToolName} 返回的 name。` },
      },
      required: ['name'],
      additionalProperties: false,
    },
  };
}

function renderText(_args, value) {
  return [{ type: 'text', text: String(value?.text ?? '') }];
}

export async function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  const params = toolParameters(config.searchToolName);
  const definitions = [];
  const register = definition => { definitions.push(definition); return definition; };

  register({
    name: config.searchToolName,
    description:
      '在技能库里按关键词检索技能（只返回名字和一行描述，不含正文）。中文按字匹配，不用写整词。' +
      `找到合适的技能后调用 ${config.loadToolName} 读取正文再执行任务。`,
    parameters: params.search,
    output: { schema: { type: 'object', properties: { text: { type: 'string' } } }, render: renderText },
    async execute(args, exec = {}) {
      try {
        const query = String(args?.query ?? '').trim();
        const { skills } = await openCatalog(ctx, config, exec, query !== '' && config.bodyIndexChars > 0);
        if (skills.length === 0) {
          return textResult(`没有在 ${config.dirs.join(', ')} 下找到任何技能。`);
        }
        if (query === '') return textResult(formatList(skills, config.loadToolName));
        const index = buildIndex(skills, { bodyIndexChars: config.bodyIndexChars });
        const { results, approximate } = searchSkills(skills, query, {
          index,
          maxResults: config.maxResults,
          minCoverage: config.minCoverage,
          scoreRatio: config.scoreRatio,
          approxMinCoverage: config.approxMinCoverage,
        });
        if (results.length === 0) {
          return textResult(
            `没有匹配 "${query}" 的技能。可用技能：${skills.map((skill) => skill.name).join(', ')}。`,
          );
        }
        return textResult(formatResults(results, { approximate, loadToolName: config.loadToolName }));
      } catch (error) {
        exec.signal?.throwIfAborted();
        return textResult(`skill_search 失败：${error?.message ?? error}`);
      }
    },
  });

  register({
    name: config.loadToolName,
    description:
      '按技能名加载完整正文；文件技能的 frontmatter 已剥离。相对资源按返回的目录或资源基址解析。',
    parameters: params.load,
    output: { schema: { type: 'object', properties: { text: { type: 'string' } } }, render: renderText },
    async execute(args, exec = {}) {
      try {
        const wanted = String(args?.name ?? '').trim();
        if (wanted === '') return textResult('skill_load 需要一个非空的 name。');
        const catalog = await openCatalog(ctx, config, exec);
        const { skills } = catalog;
        const lower = wanted.toLowerCase();
        let skill =
          skills.find((item) => item.name === wanted) ??
          skills.find((item) => item.name.toLowerCase() === lower);
        if (!skill) {
          // 模糊兜底：唯一的部分匹配名也能加载（省掉一次 skill_search 往返）。
          const partial = skills.filter((item) => item.name.toLowerCase().includes(lower));
          if (partial.length === 1) skill = partial[0];
          else if (partial.length > 1) {
            return textResult(`技能名 "${wanted}" 有歧义，可能是：${partial.map((item) => item.name).join(', ')}。请用完整名字。`);
          }
        }
        if (!skill) {
          return textResult(
            `没有名为 "${wanted}" 的技能。可用技能：${skills.map((item) => item.name).join(', ') || '(空)'}。` +
              ` 可先用 ${config.searchToolName} 检索。`,
          );
        }
        skill = await catalog.load(skill);
        if (!skill) return textResult(`技能 "${wanted}" 已不再可用。请重新搜索。`);
        const body = skill.body.trim();
        const clipped = body.length > config.maxBodyChars
          ? `${body.slice(0, config.maxBodyChars)}\n\n[正文超过 ${config.maxBodyChars} 字符，已截断]`
          : body;
        const location = skill.dir ? `目录：${skill.dir}` : `来源：${skill.provider ?? skill.source ?? 'registry'}`;
        const resource = skill.resourceBase?.kind === 'url' ? `，资源基址：${skill.resourceBase.url}`
          : skill.resourceBase?.kind === 'opaque' ? `，资源说明：${skill.resourceBase.description}` : '';
        return textResult(`技能 ${skill.name}（${location}${resource}）\n\n${clipped || '(该 SKILL.md 没有正文)'}`);
      } catch (error) {
        exec.signal?.throwIfAborted();
        return textResult(`skill_load 失败：${error?.message ?? error}`);
      }
    },
  });

  const disposers = [];
  try {
    for (const definition of definitions) {
      disposers.push(ctx.tools.register(definition, config.presets.length
        ? { when: ({ agent }) => presetEnabled(ctx, agent, config) } : {}));
    }
    await installPresetTools(ctx, definitions, config);
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    throw error;
  }

}

/** 离线调试入口：node index.mjs --list | --search "查询" [--json] [--dir PATH] */
export async function main(argv) {
  const readArg = (flag) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const dirs = readArg('--dir') ? [expandHome(readArg('--dir'))] : [homedir() + '/.dsh/skills'];
  const skills = await discoverSkills(dirs, { includeUserOnly: true });
  if (skills.length === 0) {
    console.error(`没有在 ${dirs.join(', ')} 下找到技能`);
    process.exitCode = 1;
    return;
  }
  const query = readArg('--search');
  if (query === undefined) {
    for (const skill of skills) console.log(`${skill.name}\t${skill.description}`);
    return;
  }
  const index = buildIndex(skills, {});
  const { results, approximate } = searchSkills(skills, query, { index, maxResults: 8 });
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ approximate, results: results.map((row) => ({ ...row, skill: row.skill.name })) }, null, 2));
    return;
  }
  if (results.length === 0) {
    console.log(`没有匹配 "${query}" 的技能。可用技能：${skills.map((skill) => skill.name).join(', ')}`);
    return;
  }
  if (approximate) console.log('近似结果（可能不相关）:');
  for (const { skill, score, coverage, hits } of results) {
    console.log(`- ${skill.name}  score=${score.toFixed(3)} cov=${coverage.toFixed(2)} [${hits.join(' ')}]\n  ${skill.description}`);
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main(process.argv.slice(2));
}

export default {
  name,
  inject,
  apply,
};
