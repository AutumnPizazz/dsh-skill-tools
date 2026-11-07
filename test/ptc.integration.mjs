import assert from 'node:assert/strict';
import test from 'node:test';
import { Service } from '@deepseek-ai/cordis';
import FileSystem from '@deepseek-ai/dsh-fs-local';
import Subprocess from '@deepseek-ai/dsh-subprocess-local';
import Sandbox from '@deepseek-ai/dsh-sandbox-local';
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy';
import NodeRuntime from '@deepseek-ai/dsh-ptc-runtime-node';
import * as ptc from '@deepseek-ai/dsh-tool-executor-ptc';
import * as plugin from '../index.mjs';
import { setup } from './framework-fixture.mjs';

// No persisted sessions or permission overrides in this isolated fixture.
class Projections extends Service {
  constructor(ctx) { super(ctx,'sessionProjections',true); }
  register() { return { stateOf: () => undefined }; }
}

test('PTC: official Node runtime, read-only sandbox, SDK calls and guarded nested execution', {timeout:30000}, async t => {
  const {ctx,mount,agent} = await setup(t);
  await mount(ctx,FileSystem);
  await mount(ctx,Subprocess);
  await mount(ctx,Sandbox);
  await mount(ctx,Projections);
  await mount(ctx,SandboxPolicy,{mode:'read-only',workspaceRoot:process.cwd()});
  await mount(ctx,NodeRuntime,{timeoutMs:15000,maxTimeoutMs:20000});
  const a = await agent('ptc');
  await mount(a.ctx,ptc,{});
  await mount(ctx,plugin,{dirs:['./test/fixtures'],catalogSource:'registry'});
  const assembly = await ctx.systemPrompt.assemble({scope:a});
  assert.deepEqual(assembly.tools.map(x=>x.name),['run_code']);
  assert.ok(assembly.sections.some(x=>x.text.includes('skill_search') && x.text.includes('skill_load')));
  assert.equal(ctx.tools.get('skill',a),undefined);
  const call = async (code,id) => ctx.tools.execute({agent:a,signal:t.signal,calls:[{type:'tool-call',id,name:'run_code',arguments:JSON.stringify({code,description:'Read isolated synthetic skill fixture'})}]});
  const r=await call('const found = await tools.skill_search({query:""}); const loaded = await tools.skill_load({name:"fixture-skill"}); return {found,loaded};','ptc-success');
  assert.equal(r.results[0].result.isError,false,JSON.stringify(r.results[0].result));
  assert.match(JSON.stringify(r.results[0].result.value),/Fixture body/);
  let guarded=0;
  const undo=ctx.tools.guard(exec => {if(exec.name==='skill_load'){guarded++;return 'fixture guard retained';}});
  t.after(undo);
  const denied=await call('return await tools.skill_load({name:"fixture-skill"});','ptc-guard');
  assert.equal(guarded,1);
  assert.equal(denied.results[0].result.isError,true);
  assert.equal(ctx.sandboxPolicy.defaultMode,'read-only');
});
