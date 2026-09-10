import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const projectRoot = path.resolve(import.meta.dirname, '..');
const busManager = fs.readFileSync(path.join(projectRoot, 'wled', 'wled00', 'bus_manager.cpp'), 'utf8');
const busManagerHeader = fs.readFileSync(path.join(projectRoot, 'wled', 'wled00', 'bus_manager.h'), 'utf8');
const fpvUsermod = fs.readFileSync(path.join(projectRoot, 'wled', 'usermods', 'fpv_race_display', 'fpv_race_display.cpp'), 'utf8');

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

test('HUB75 marks a transition to black dirty so removed pixels are cleared', () => {
  const setPixelColor = functionBody(busManager, 'void IRAM_ATTR BusHub75Matrix::setPixelColor(');

  // A non-buffered HUB75 path still has to publish black when a previously lit
  // pixel disappears. Tracking only non-black pixels leaves old text/arrows in
  // the DMA frame and creates the observed visual overlap.
  assert.doesNotMatch(setPixelColor, /if\s*\(\s*\(c\s*==\s*IS_BLACK\).*?\)\s*return/s);
  assert.doesNotMatch(setPixelColor, /setBitInArray\(_ledsDirty, pix, c != IS_BLACK\)/);
  assert.match(setPixelColor, /setBitInArray\(_ledsDirty, pix, true\)/);
});

test('HUB75 tracks each logical pixel change for both DMA buffers', () => {
  const setPixelColor = functionBody(busManager, 'void IRAM_ATTR BusHub75Matrix::setPixelColor(');
  const show = functionBody(busManager, 'void BusHub75Matrix::show(void)');

  assert.match(busManagerHeader, /byte \*_ledsDirtySecondary = nullptr/);
  assert.match(busManagerHeader, /uint8_t _dmaBufferIndex = 0/);
  assert.match(setPixelColor, /setBitInArray\(_ledsDirty, pix, true\)/);
  assert.match(setPixelColor, /setBitInArray\(_ledsDirtySecondary, pix, true\)/);
  assert.match(show, /byte \*dirty = _dmaBufferIndex \? _ledsDirtySecondary : _ledsDirty/);
  assert.match(show, /getBitFromArray\(dirty, pix\)/);
  assert.match(show, /setBitArray\(dirty, _len, false\)/);
  assert.match(show, /_dmaBufferIndex \^= 1/);
});

test('FPV race mode fully replaces the WLED background effect', () => {
  const overlay = functionBody(fpvUsermod, 'void handleOverlayDraw() override');
  assert.match(overlay, /strip\.fill\(_scene\.background\)/);
  assert.doesNotMatch(overlay, /color_fade|_backgroundEffectPercent|getPixelColorNoMap/);

  const controls = functionBody(fpvUsermod, 'void readDisplayControls(');
  assert.doesNotMatch(controls, /backgroundEffect/);
});
