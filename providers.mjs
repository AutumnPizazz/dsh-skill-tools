/** 合并 dsh 原生 provider 与目录回退；不缓存，不越过原生 invocation 策略。 */
import path from 'node:path';
import { discoverSkills } from './catalog.mjs';
import { serviceOf } from './presets.mjs';

function record(skill) {
  const metadata = skill.metadata ?? {};
  const dir = skill.resourceBase?.kind === 'directory' ? skill.resourceBase.path
    : skill.path ? path.dirname(skill.path) : undefined;
  return {
    name: skill.name, description: skill.description ?? '',
    whenToUse: skill.whenToUse ?? metadata.whenToUse ?? '',
    keywords: Array.isArray(metadata.keywords) ? metadata.keywords.join(', ') : String(metadata.keywords ?? ''),
    body: skill.content ?? '', dir, file: skill.path, source: skill.source,
    provider: skill.provider, resourceBase: skill.resourceBase, registry: true,
  };
}

export async function openCatalog(ctx, config, exec = {}, withBodies = false) {
  exec.signal?.throwIfAborted();
  const registry = config.catalogSource === 'filesystem' ? undefined : serviceOf(ctx, 'skills');
  if (config.catalogSource === 'registry' && !registry) {
    throw new Error('dsh-skill-tools: registry catalog requires the dsh skills service');
  }
  const files = config.catalogSource === 'registry' ? []
    : await discoverSkills(config.dirs, { includeUserOnly: config.includeUserOnly });
  const workingDirectory = serviceOf(ctx, 'workingDirectory');
  const lookup = {
    scope: exec.agent, signal: exec.signal,
    cwd: exec.agent && workingDirectory ? await workingDirectory.ensure(exec.agent, exec.signal) : undefined,
  };
  const summaries = registry ? await registry.list(lookup) : [];
  const loadNative = async (name) => {
    exec.signal?.throwIfAborted();
    const definition = await registry.get(name, lookup);
    exec.signal?.throwIfAborted();
    return definition && definition.invocation?.modelInvocable !== false ? record(definition) : null;
  };
  // 原生 registry 的同名赢家有最终优先级，禁止的名字也不能从文件回退中重新出现。
  const claimed = new Set(summaries.map(skill => skill.name));
  const skills = files.filter(skill => !claimed.has(skill.name));
  for (const summary of summaries) {
    if (summary.invocation?.modelInvocable === false) continue;
    const skill = withBodies ? await loadNative(summary.name) : record(summary);
    if (skill) skills.push(skill);
  }
  exec.signal?.throwIfAborted();
  skills.sort((a,b) => a.name.localeCompare(b.name));
  return { skills, load: async skill => skill.registry ? loadNative(skill.name) : skill };
}
