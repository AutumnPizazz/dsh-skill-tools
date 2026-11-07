import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { boot, readProfilePatches } from '@deepseek-ai/dsh-app-boot';
import PluginManager from '@deepseek-ai/dsh-plugin-manager';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import Skills from '@deepseek-ai/dsh-skill';
import * as native from '@deepseek-ai/dsh-tool-executor-native';

// Uses the same inventory and enablement API as the installed-plugins page.
test('native PluginManager lists the linked bundle and persists enablement', { timeout: 20000 }, async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-bundle-manager-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = path.join(home, 'profiles', 'fixture');
  await mkdir(path.join(dir, 'node_modules'), { recursive: true });
  await symlink(fileURLToPath(new URL('../', import.meta.url)), path.join(dir, 'node_modules', 'dsh-skill-tools'), 'dir');
  const installAnchor = path.join(home, 'package.json');
  const absoluteConfig = path.join(home, 'cordis.yml');
  await writeFile(installAnchor, JSON.stringify({ name: 'fixture-host', dependencies: {} }));
  await writeFile(absoluteConfig, '[]\n');
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({
    name: 'fixture-profile', dependencies: { 'dsh-skill-tools': 'link:./node_modules/dsh-skill-tools' },
    dsh: { profile: { bundles: ['dsh-skill-tools'] } },
  }));
  let ctx;
  t.after(async () => { await ctx?.fiber.dispose(); });
  const open = async enabled => {
    const profile = { name: 'fixture', dir, patchPath: path.join(dir, 'cordis.patch.yml'),
      installAnchor, cwd: home, home, startedBundles: enabled ? ['dsh-skill-tools'] : [], overlays: [], telemetryDisabledEnv: '1' };
    return boot('bundle-fixture', absoluteConfig, readProfilePatches('dsh', profile), async host => {
      host.provide('profileContext', profile);
      await host.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false });
      await host.plugin(Tools);
      await host.plugin(Skills);
      await host.plugin(native);
      await host.plugin(PluginManager, { registry: 'https://registry.npmjs.org/', fallbackRegistries: [] });
    }, pathToFileURL(path.join(dir, 'package.json')).href);
  };
  ctx = await open(true);
  let manager = ctx.get('pluginManager');
  const card = (await manager.listBundles()).find(row => row.name === 'dsh-skill-tools');
  assert.ok(card);
  assert.equal(card.installed, true);
  assert.equal(card.enabled, true);
  assert.equal(card.official, false);
  assert.equal(card.error, undefined);
  assert.equal(card.rows[0].moduleName, 'dsh-skill-tools');
  assert.ok(Object.values(card.meta.title).includes('skill-tools'));
  const entry = (await manager.listPlugins()).find(row => row.moduleName === 'dsh-skill-tools');
  assert.equal(entry.patchId, 'skill-tools');
  const schemas = await ctx.get('systemPrompt').assemble({});
  assert.deepEqual(schemas.tools.map(tool => tool.name).sort(), ['skill_load', 'skill_search']);
  const off = await manager.setBundleEnabled('dsh-skill-tools', false);
  assert.equal(off.changed, true);
  assert.equal((await manager.listBundles()).find(row => row.name === 'dsh-skill-tools').enabled, false);
  await ctx.fiber.dispose(); ctx = undefined;
  ctx = await open(false);
  assert.equal(ctx.get('tools').get('skill_search'), undefined);
  manager = ctx.get('pluginManager');
  assert.equal((await manager.setBundleEnabled('dsh-skill-tools', true)).changed, true);
  const saved = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
  assert.ok(saved.dsh.profile.bundles.includes('dsh-skill-tools'));
  await ctx.fiber.dispose(); ctx = undefined;
  ctx = await open(true);
  assert.ok(ctx.get('tools').get('skill_load'));
});
