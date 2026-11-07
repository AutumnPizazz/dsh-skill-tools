import assert from 'node:assert/strict';
import test from 'node:test';
import { installPresetTools } from '../presets.mjs';
import { resolveConfig } from '../catalog.mjs';

const names = ['skill_search', 'skill_load'];
function fixture(preset = 'standard') {
  const global = new Map([['bash', { name: 'bash' }], ['skill', { name: 'skill' }]]);
  const local = new Map(), denies = new Set(), listeners = new Map(), cleanup = [];
  const definitions = names.map(name => ({ name }));
  for (const d of definitions) global.set(d.name, d);
  const agent = { session: {}, ctx: { tools: {
    register(d) { if (local.has(d.name)) throw Error('duplicate local tool'); local.set(d.name,d); return () => local.delete(d.name); },
    restrict({deny}) { for (const name of deny) denies.add(name); return () => { for (const name of deny) denies.delete(name); }; },
  } } };
  const ctx = {
    tools: {
      get(name) { return local.get(name) ?? (denies.has(name) ? undefined : global.get(name)); },
      view() { return { restrictableNames: new Set(global.keys()) }; },
    },
    agents: { list: () => [agent], get: () => agent },
    get(key) { if (key === 'tools') return this.tools; if (key === 'agents') return this.agents; if (key === 'sessionProjections') return {stateOf: () => preset}; },
    on(name,fn) { listeners.set(name,fn); }, effect(fn) { cleanup.push(fn()); },
  };
  return {ctx, agent, definitions, global, local, denies, listeners, cleanup};
}

test('默认覆盖所有预设，源目录和替换工具可配置', () => {
  const c=resolveConfig();assert.deepEqual(c.presets,[]);assert.deepEqual(c.replaceTools,['skill']);assert.equal(c.catalogSource,'auto');
  assert.throws(()=>resolveConfig({replaceTools:['skill_search']}), /replaceTools/);
  assert.throws(()=>resolveConfig({catalogSource:'other'}), /catalogSource/);
});
for (const preset of ['standard','minimal','cordis','ptc','custom-team','unknown']) {
  test(`${preset}: 注册两工具、替换 skill、保留 bash，卸载恢复`, () => {
    const f=fixture(preset);const bash=f.global.get('bash');
    installPresetTools(f.ctx,f.definitions,resolveConfig());
    assert.deepEqual([...f.local.keys()],names);assert.equal(f.ctx.tools.get('skill',f.agent),undefined);
    assert.equal(f.ctx.tools.get('bash',f.agent),bash);
    for (const fn of f.cleanup) fn();
    assert.equal(f.local.size,0);assert.equal(f.denies.size,0);assert.equal(f.ctx.tools.get('skill',f.agent).name,'skill');
  });
}
test('排除的预设不替换原工具', () => {
  const f=fixture('standard');installPresetTools(f.ctx,f.definitions,resolveConfig({presets:['minimal']}));assert.equal(f.local.size,0);assert.equal(f.denies.size,0);
});
test('预设切换和创建不重复注册，agent 释放即清理', () => {
  const f=fixture();installPresetTools(f.ctx,f.definitions,resolveConfig());
  f.listeners.get('agent/created')({agent:f.agent});f.listeners.get('agent-preset/selected')('id','standard');assert.equal(f.local.size,2);
  f.listeners.get('agent/disposed')({agent:f.agent});assert.equal(f.local.size,0);assert.equal(f.denies.size,0);
});
test('同层注册冲突明确失败并回滚，不删除外部工具', () => {
  const f=fixture();const external={name:'skill_load'};f.local.set('skill_load',external);
  assert.throws(()=>installPresetTools(f.ctx,f.definitions,resolveConfig()), /duplicate/);
  assert.deepEqual([...f.local.values()],[external]);assert.equal(f.denies.size,0);
});
