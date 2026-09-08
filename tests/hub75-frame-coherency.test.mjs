import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const projectRoot = path.resolve(import.meta.dirname, '..');
const busManager = fs.readFileSync(path.join(projectRoot, 'wled', 'wled00', 'bus_manager.cpp'), 'utf8');

function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const openingBrace = source.indexOf('{', start);
  assert.notEqual(openingBrace, -1, `missing opening brace for ${signature}`);
  let depth = 0;
  for (let index = openingBrace; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}' && --depth === 0) return source.slice(openingBrace, index + 1);
  }
  assert.fail(`unterminated ${signature}`);
}

test('HUB75 uses the driver double buffer for complete-frame publication', () => {
  const constructor = functionBody(busManager, 'BusHub75Matrix::BusHub75Matrix(');
  assert.match(constructor, /mxconfig\.double_buff\s*=\s*true/);
  assert.doesNotMatch(constructor, /mxconfig\.double_buff\s*=\s*false/);

  const show = functionBody(busManager, 'void BusHub75Matrix::show(void)');
  const firstDraw = show.search(/(?:virtualDisp|display)->drawPixelRGB888/);
  const flip = show.indexOf('flipDMABuffer()');
  assert.ok(firstDraw >= 0, 'show() must paint the inactive DMA frame');
  assert.ok(flip > firstDraw, 'DMA publication must happen after the complete frame is painted');
  assert.match(show, /if\s*\(\s*!hasDirtyPixels\s*\)\s*return/);
  assert.match(show, /while\s*\(millis\(\)\s*-\s*_lastFrameFlipAt\s*<\s*_framePeriodMs\)\s*delay\(1\)/);
  assert.ok(show.indexOf('setBitArray(_ledsDirty') > flip, 'dirty state must be cleared after publication');
  assert.ok(show.indexOf('else if (_frameDirty)') > flip, 'direct-draw fallback must also publish a complete frame');
});
