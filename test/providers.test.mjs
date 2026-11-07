import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openCatalog } from '../providers.mjs';
import { resolveConfig } from '../catalog.mjs';

async function fixture(t) {
  const dir=await mkdtemp(path.join(tmpdir(),'dsh-skill-tools-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  for (const name of ['local','shared']) {await mkdir(path.join(dir,name));await writeFile(path.join(dir,name,'SKILL.md'),`---\nname: ${name}\ndescription: local fixture\n---\nfile body`);}
  return dir;
}
test('自动合并 registry/本地目录，保留作用域/cwd/取消信号和原生优先级',async t=>{
  const dir=await fixture(t);const agent={};const signal=new AbortController().signal;let seen;
  const definition={name:'shared',description:'provider wins',content:'provider body',provider:'runtime',invocation:{modelInvocable:true},metadata:{keywords:['render']}};
  const ctx={skills:{list:async o=>{seen=o;return [definition];},get:async()=>definition},workingDirectory:{ensure:async a=>{assert.equal(a,agent);return '/project';}}};
  const c=await openCatalog(ctx,resolveConfig({dirs:[dir]}),{agent,signal},true);
  assert.equal(c.skills.length,2);assert.equal(c.skills.find(s=>s.name==='shared').body,'provider body');
  assert.equal(seen.scope,agent);assert.equal(seen.cwd,'/project');assert.equal(seen.signal,signal);
  assert.equal((await c.load(c.skills.find(s=>s.name==='shared'))).body,'provider body');
});
test('原生禁止模型调用的条目不会被同名本地文件重新暴露',async t=>{
  const dir=await fixture(t);const ctx={skills:{list:async()=>[{name:'shared',invocation:{modelInvocable:false}}],get:async()=>{throw Error('should not load');}}};
  const c=await openCatalog(ctx,resolveConfig({dirs:[dir],includeUserOnly:true}),{},true);assert.deepEqual(c.skills.map(s=>s.name),['local']);
});
test('加载重新检查可用性，列目录不读取所有正文',async()=>{
  let enabled=true, reads=0;const d={name:'virtual',description:'test',provider:'runtime',content:'body',invocation:{modelInvocable:true}};
  const ctx={skills:{list:async()=>[d],get:async()=>{reads++;return {...d,invocation:{modelInvocable:enabled}};}}};
  const c=await openCatalog(ctx,resolveConfig({catalogSource:'registry'}),{},false);assert.equal(reads,0);enabled=false;assert.equal(await c.load(c.skills[0]),null);
});
test('仅 registry 模式缺服务报错，取消不会启动发现',async()=>{
  await assert.rejects(openCatalog({},resolveConfig({catalogSource:'registry'}),{},false),/registry/);
  const abort=new AbortController();abort.abort();await assert.rejects(openCatalog({},resolveConfig(),{signal:abort.signal},false),/abort/i);
});
