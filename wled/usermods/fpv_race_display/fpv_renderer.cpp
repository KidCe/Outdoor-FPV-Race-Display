#include "fpv_renderer.h"

namespace fpv_display {

// Canonical 5x7 uppercase glyph rows. Other declared sizes are sampled from
// this bitmap, keeping the renderer small and avoiding any per-effect buffer.
struct Glyph { char character; uint8_t rows[7]; };
static const Glyph GLYPHS[] PROGMEM = {
  {' ',{0,0,0,0,0,0,0}},{'A',{14,17,17,31,17,17,17}},{'B',{30,17,17,30,17,17,30}},
  {'C',{15,16,16,16,16,16,15}},{'D',{30,17,17,17,17,17,30}},{'E',{31,16,16,30,16,16,31}},
  {'F',{31,16,16,30,16,16,16}},{'G',{15,16,16,23,17,17,15}},{'H',{17,17,17,31,17,17,17}},
  {'I',{4,4,4,4,4,4,4}},{'J',{7,2,2,2,18,18,12}},{'K',{17,18,20,24,20,18,17}},
  {'L',{16,16,16,16,16,16,31}},{'M',{17,27,21,21,17,17,17}},{'N',{17,25,21,19,17,17,17}},
  {'O',{14,17,17,17,17,17,14}},{'P',{30,17,17,30,16,16,16}},{'Q',{14,17,17,17,21,18,13}},
  {'R',{30,17,17,30,20,18,17}},{'S',{15,16,16,14,1,1,30}},{'T',{31,4,4,4,4,4,4}},
  {'U',{17,17,17,17,17,17,14}},{'V',{17,17,17,17,17,10,4}},{'W',{17,17,17,21,21,21,10}},
  {'X',{17,17,10,4,10,17,17}},{'Y',{17,17,10,4,4,4,4}},{'Z',{31,1,2,4,8,16,31}},
  {'0',{14,17,19,21,25,17,14}},{'1',{4,12,4,4,4,4,14}},{'2',{14,17,1,2,4,8,31}},
  {'3',{30,1,1,14,1,1,30}},{'4',{2,6,10,18,31,2,2}},{'5',{31,16,16,30,1,1,30}},
  {'6',{15,16,16,30,17,17,14}},{'7',{31,1,2,4,8,8,8}},{'8',{14,17,17,14,17,17,14}},
  {'9',{14,17,17,15,1,1,14}},{'/',{1,2,4,8,16,0,0}},{'-',{0,0,0,31,0,0,0}},
  {':',{0,4,4,0,4,4,0}},{'.',{0,0,0,0,0,6,6}},{'|',{4,4,4,4,4,4,4}},
  {'_',{0,0,0,0,0,0,31}},{'+',{0,4,4,31,4,4,0}},{'=',{0,31,0,31,0,0,0}},
  {'>',{16,8,4,2,4,8,16}},{'<',{1,2,4,8,4,2,1}},{'!',{4,4,4,4,4,0,4}},
  {'?',{14,17,1,2,4,0,4}}
};

uint8_t Renderer::glyphRow(char character, uint8_t row) {
  if (character >= 'a' && character <= 'z') character -= 32;
  for (size_t i = 0; i < sizeof(GLYPHS) / sizeof(GLYPHS[0]); i++) {
    if (static_cast<char>(pgm_read_byte(&GLYPHS[i].character)) == character) return pgm_read_byte(&GLYPHS[i].rows[row]);
  }
  return glyphRow('?', row);
}

const Value* Renderer::findValue(const char* key) const {
  if (!_state || !key || !key[0]) return nullptr;
  for (uint8_t i = 0; i < _state->valueCount; i++) if (sameText(_state->values[i].key, key)) return &_state->values[i];
  return nullptr;
}

uint32_t Renderer::hsv(uint8_t hue, uint8_t saturation, uint8_t value) {
  uint8_t target[4] = {};
  hsv2rgb_rainbow(static_cast<uint16_t>(hue) * 257U, saturation, value, target, false);
  return RGBW32(target[0], target[1], target[2], 0);
}

uint32_t Renderer::nodeColor(const Node& node, const Value* value, int16_t x, int16_t y, uint32_t now) const {
  const uint32_t base = value && value->hasColor ? value->color : node.color;
  const Effect effect = value && value->hasEffect ? value->effect : node.effect;
  const uint8_t phase = static_cast<uint8_t>(now / 12);
  if (effect == Effect::Rainbow) return hsv(phase + x * 11 + y * 5, 255, 255);
  if (effect == Effect::Glitter) {
    const uint32_t tick = now / 110;
    const uint32_t hash = static_cast<uint32_t>(x * 71 + y * 37) + tick * 29 + (tick >> 2) * 17;
    if ((hash % 197) == 0) return hsv(phase + hash, 255, 255);
    return base;
  }
  return base;
}

void Renderer::pixel(Segment& segment, int16_t x, int16_t y, uint32_t color) const {
  if (!_scene || x < 0 || y < 0 || x >= static_cast<int16_t>(_scene->width) || y >= static_cast<int16_t>(_scene->height)) return;
  segment.setPixelColorXY(x, y, color);
}

void Renderer::rect(Segment& segment, int16_t x, int16_t y, int16_t width, int16_t height, uint32_t color, bool filled, uint8_t thickness) const {
  if (width <= 0 || height <= 0) return;
  if (filled) {
    for (int16_t py = y; py < y + height; py++) for (int16_t px = x; px < x + width; px++) pixel(segment, px, py, color);
    return;
  }
  for (uint8_t t = 0; t < thickness; t++) {
    line(segment, x + t, y + t, x + width - 1 - t, y + t, color, 1);
    line(segment, x + t, y + height - 1 - t, x + width - 1 - t, y + height - 1 - t, color, 1);
    line(segment, x + t, y + t, x + t, y + height - 1 - t, color, 1);
    line(segment, x + width - 1 - t, y + t, x + width - 1 - t, y + height - 1 - t, color, 1);
  }
}

void Renderer::line(Segment& segment, int16_t x0, int16_t y0, int16_t x1, int16_t y1, uint32_t color, uint8_t thickness) const {
  int16_t dx = abs(x1 - x0), sx = x0 < x1 ? 1 : -1, dy = -abs(y1 - y0), sy = y0 < y1 ? 1 : -1, error = dx + dy;
  while (true) {
    for (uint8_t tx = 0; tx < thickness; tx++) for (uint8_t ty = 0; ty < thickness; ty++) pixel(segment, x0 + tx, y0 + ty, color);
    if (x0 == x1 && y0 == y1) break;
    const int16_t doubled = 2 * error;
    if (doubled >= dy) { error += dy; x0 += sx; }
    if (doubled <= dx) { error += dx; y0 += sy; }
  }
}

void Renderer::text(Segment& segment, const Node& node, const Value* value, uint32_t now) const {
  const char* content = value ? value->text : node.text;
  const size_t length = strlen(content);
  if (!length) return;
  const int16_t advance = (node.fontWidth + 1) * node.scale;
  const int16_t textWidth = length * advance - node.scale;
  int16_t originX = node.x;
  if (node.align == Align::Center) originX += (node.width - textWidth) / 2;
  else if (node.align == Align::Right) originX += node.width - textWidth;

  for (size_t index = 0; index < length; index++) {
    for (uint8_t gy = 0; gy < node.fontHeight; gy++) {
      const uint8_t sourceY = static_cast<uint8_t>(gy * 7 / node.fontHeight) > 6 ? 6 : static_cast<uint8_t>(gy * 7 / node.fontHeight);
      const uint8_t row = glyphRow(content[index], sourceY);
      for (uint8_t gx = 0; gx < node.fontWidth; gx++) {
        const uint8_t sourceX = static_cast<uint8_t>(gx * 5 / node.fontWidth) > 4 ? 4 : static_cast<uint8_t>(gx * 5 / node.fontWidth);
        if (!(row & (1 << (4 - sourceX)))) continue;
        for (uint8_t sy = 0; sy < node.scale; sy++) for (uint8_t sx = 0; sx < node.scale; sx++) {
          const int16_t px = originX + index * advance + gx * node.scale + sx;
          const int16_t py = node.y + gy * node.scale + sy;
          if (px >= node.x && px < node.x + node.width && (!node.height || py < node.y + node.height)) pixel(segment, px, py, nodeColor(node, value, px, py, now));
        }
      }
    }
  }
}

bool Renderer::isAnimated() const {
  if (!_scene) return false;
  for (uint8_t i = 0; i < _scene->nodeCount; i++) {
    const Value* value = findValue(_scene->nodes[i].binding);
    const Effect effect = value && value->hasEffect ? value->effect : _scene->nodes[i].effect;
    if (effect != Effect::None) return true;
  }
  return false;
}

void Renderer::render(Segment& segment, uint32_t now, bool drawBackground) {
  if (!_scene) return;
  if (drawBackground) rect(segment, 0, 0, _scene->width, _scene->height, _scene->background, true, 1);
  for (uint8_t i = 0; i < _scene->nodeCount; i++) {
    const Node& node = _scene->nodes[i];
    const Value* value = findValue(node.binding);
    const uint32_t color = nodeColor(node, value, node.x, node.y, now);
    switch (node.type) {
      case NodeType::Text: text(segment, node, value, now); break;
      case NodeType::Rect: rect(segment, node.x, node.y, node.width, node.height, color, node.filled, node.thickness); break;
      case NodeType::Line: line(segment, node.x, node.y, node.x2, node.y2, color, node.thickness); break;
      case NodeType::Polyline:
        for (uint8_t point = 1; point < node.pointCount; point++) line(segment, node.points[point - 1].x, node.points[point - 1].y, node.points[point].x, node.points[point].y, color, node.thickness);
        break;
    }
  }
}

} // namespace fpv_display
