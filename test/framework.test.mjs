import assert from 'node:assert/strict';
import test from 'node:test';
import * as plugin from '../index.mjs';
import { setup } from './framework-fixture.mjs';

for (const mode of ['standard', 'minimal', 'cordis', 'ptc', 'custom']) {
  test(`real framework: ${mode} scoped replacement, schemas, execution, disposal`, async t => {
    const { ctx, mount, agent } = await setup(t);
    const a = await agent(mode);
    const original = ctx.tools.get('skill', a);
    const bash = ctx.tools.get('bash', a);
    const fiber = await mount(ctx, plugin, { dirs: ['./test/fixtures'], catalogSource: 'registry' });
    assert.equal(ctx.tools.get('skill', a), undefined);
    assert.equal(ctx.tools.get('bash', a), bash);
    assert.equal(ctx.tools.get('fixture_hidden', a), undefined);
    const assembly = await ctx.systemPrompt.assemble({ scope: a });
    const schemas = assembly.tools.map(s => s.name);
    assert.ok(schemas.includes('skill_search'));
    assert.ok(schemas.includes('skill_load'));
    assert.ok(!schemas.includes('skill'));
    const searchSchema = assembly.tools.find(s => s.name === 'skill_search');
    assert.equal(searchSchema.parameters.properties.query.type, 'string');
    const signal = new AbortController().signal;
    for (const [name, args, expected] of [['skill_search', {query:''}, /fixture-skill/], ['skill_load', {name:'fixture-skill'}, /Fixture body/]]) {
      const result = await ctx.tools.execute({ agent:a, signal, calls:[{type:'tool-call',id:`${mode}-${name}`,name,arguments:JSON.stringify(args)}] });
      assert.equal(result.results[0].result.isError, false);
      assert.match(result.results[0].result.value.text, expected);
    }
    await fiber.dispose();
    assert.equal(ctx.tools.get('skill', a), original);
    assert.equal(ctx.tools.get('skill_search', a), undefined);
    assert.equal(ctx.tools.get('fixture_hidden', a), undefined);
  });
}

test('real framework: late agents and existing guards survive plugin activation', async t => {
  const {ctx,mount,agent} = await setup(t);
  await mount(ctx,plugin,{dirs:['./test/fixtures'],catalogSource:'registry'});
  const a = await agent('late');
  assert.ok(ctx.tools.get('skill_load',a));
  let checked = 0;
  const undo = ctx.tools.guard(exec => { if(exec.name==='skill_load'){ checked++; return 'fixture guard retained'; } });
  t.after(undo);
  const r = await ctx.tools.execute({agent:a,signal:new AbortController().signal,calls:[{type:'tool-call',id:'guard',name:'skill_load',arguments:'{"name":"fixture-skill"}'}]});
  assert.equal(checked,1);
  assert.equal(r.results[0].result.isError,true);
});


test('real framework: agents service may start after this plugin', async t => {
  const {ctx,mount,agent,startAgents} = await setup(t,true);
  await mount(ctx,plugin,{dirs:['./test/fixtures'],catalogSource:'registry'});
  await startAgents();
  const a=await agent('delayed-service');
  assert.ok(ctx.tools.get('skill_search',a));
  assert.equal(ctx.tools.get('skill',a),undefined);
});

test('registry resource bases remain available for URL and opaque providers', async t => {
  const {ctx,mount,agent}=await setup(t);
  ctx.skills.register({name:'url-fixture',description:'URL resources',source:'runtime',content:'URL body',resourceBase:{kind:'url',url:'https://example.invalid/fixtures/'}});
  ctx.skills.register({name:'opaque-fixture',description:'Opaque resources',source:'runtime',content:'Opaque body',resourceBase:{kind:'opaque',description:'fixture resource namespace'}});
  const a=await agent('resource-fixture');
  await mount(ctx,plugin,{dirs:['./test/fixtures'],catalogSource:'registry'});
  for(const [name,expected] of [['url-fixture',/https:\/\/example.invalid\/fixtures\//],['opaque-fixture',/fixture resource namespace/]]){
    const r=await ctx.tools.execute({agent:a,signal:new AbortController().signal,calls:[{type:'tool-call',id:name,name:'skill_load',arguments:JSON.stringify({name})}]});
    assert.equal(r.results[0].result.isError,false);
    assert.match(r.results[0].result.value.text,expected);
  }
});
