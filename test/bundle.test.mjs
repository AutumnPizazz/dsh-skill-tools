import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const root = new URL('../', import.meta.url);

test('declares a native dsh bundle and includes its patch in the archive', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.ok(pkg.files.includes('cordis.patch.yml'));
  const patch = await readFile(new URL('cordis.patch.yml', root), 'utf8');
  assert.match(patch, /id: skill-tools/);
  assert.match(patch, /name: dsh-skill-tools/);
});

test('exports localized metadata for the native plugin card', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json');
  assert.ok(pkg.files.includes('locale'));
  for (const language of ['en', 'zh']) {
    const { meta } = JSON.parse(await readFile(new URL(`locale/${language}.json`, root), 'utf8'));
    assert.equal(meta.title, 'skill-tools');
    assert.ok(meta.description.length > 0);
  }
});
