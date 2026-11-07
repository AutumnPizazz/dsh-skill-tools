import { Context, Service } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import { createScope } from '@deepseek-ai/dsh-scope';
import * as native from '@deepseek-ai/dsh-tool-executor-native';
import * as nativeSkill from '@deepseek-ai/dsh-tool-skill';

class Agents extends Service {
  constructor(ctx) { super(ctx, 'agents', true); this.items = []; }
  list() { return this.items; }
  get(id) { return this.items.find(a => a.session.id === id); }
}
class WorkingDirectory extends Service {
  constructor(ctx) { super(ctx, 'workingDirectory', true); }
  async ensure() { return process.cwd(); }
}
const dummy = name => ({ name, description: 'Isolated fixture; never executes a shell.', parameters: {},
  output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
  async execute() { return 'fixture'; } });

export async function setup(t, lateServices = false) {
  const ctx = new Context();
  const cleanups = [];
  const mount = async (c, p, config) => { const f = await c.plugin(p, config); cleanups.push(() => f.dispose()); return f; };
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
  await mount(ctx, SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false });
  await mount(ctx, Tools);
  await mount(ctx, SkillRegistry);
  if (!lateServices) await mount(ctx, Agents);
  await mount(ctx, WorkingDirectory);
  await mount(ctx, native);
  ctx.tools.register(dummy('bash'));
  ctx.tools.register(dummy('fixture_hidden'));
  ctx.skills.register({ name: 'fixture-skill', description: 'isolated integration fixture', source: 'runtime', content: '# Fixture body' });
  let host;
  const hostFiber = await mount(ctx, { name: 'fixture-host', inject: ['tools','skills','agents','workingDirectory','systemPrompt'], apply(c) { host = c; } });
  const agent = async (id, withNative = id !== 'minimal') => {
    const presetKey = { id };
    const preset = createScope(host, presetKey); cleanups.push(() => preset.dispose());
    if (withNative) await mount(preset.ctx, nativeSkill);
    preset.ctx.tools.restrict({ deny: ['fixture_hidden'] });
    const a = { session: { id, header: { cwd: process.cwd() }, events: [], append(type, data) { this.events.push({type,data}); } }, config: {} };
    const scope = createScope(host, a, { parent: presetKey }); cleanups.push(() => scope.dispose());
    a.ctx = scope.ctx;
    ctx.agents.items.push(a);
    await ctx.serial('agent/created', { agent: a, source: 'session' });
    return a;
  };
  return { ctx, mount, agent, async startAgents() { await mount(ctx, Agents); await hostFiber.await(); } };
}
