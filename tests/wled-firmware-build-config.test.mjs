import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const projectRoot = path.resolve(import.meta.dirname, '..');
const platformio = fs.readFileSync(path.join(projectRoot, 'wled', 'platformio.ini'), 'utf8');
const readme = fs.readFileSync(path.join(projectRoot, 'README.md'), 'utf8');

function environmentBlock(name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = platformio.match(new RegExp(`\\[env:${escapedName}\\]\\r?\\n([\\s\\S]*?)(?=\\r?\\n\\[|$)`));
  assert.ok(match, `missing PlatformIO environment ${name}`);
  return match[1];
}

test('canonical classic FPV target includes the local usermod', () => {
  const block = environmentBlock('esp32dev_hub75_p4_80x40_fpv');
  assert.match(block, /extends\s*=\s*env:esp32dev_hub75_p4_80x40/);
  assert.match(block, /custom_usermods\s*=\s*\$\{env:esp32dev_hub75_p4_80x40\.custom_usermods\}\s+fpv_race_display/);
});

test('canonical Waveshare FPV target includes the local usermod', () => {
  const block = environmentBlock('waveshare_p4_80x40_fpv');
  assert.match(block, /extends\s*=\s*env:waveshare_p4_80x40/);
  assert.match(block, /custom_usermods\s*=\s*\$\{env:waveshare_p4_80x40\.custom_usermods\}/);
  assert.match(block, /fpv_race_display/);
});

test('README build commands name environments that exist in platformio.ini', () => {
  for (const name of ['esp32dev_hub75_p4_80x40_fpv', 'waveshare_p4_80x40_fpv']) {
    assert.match(readme, new RegExp(`pio run -e ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    environmentBlock(name);
  }
});
