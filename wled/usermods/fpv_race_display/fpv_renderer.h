#pragma once

#include "fpv_scene.h"

namespace fpv_display {

class Renderer {
public:
  void attach(Scene* scene, DisplayState* state) { _scene = scene; _state = state; }
  void render(Segment& segment, uint32_t now, bool drawBackground = true);
  bool isAnimated() const;

private:
  Scene* _scene = nullptr;
  DisplayState* _state = nullptr;

  const Value* findValue(const char* key) const;
  uint32_t nodeColor(const Node& node, const Value* value, int16_t x, int16_t y, uint32_t now) const;
  void pixel(Segment& segment, int16_t x, int16_t y, uint32_t color) const;
  void rect(Segment& segment, int16_t x, int16_t y, int16_t width, int16_t height, uint32_t color, bool filled, uint8_t thickness) const;
  void line(Segment& segment, int16_t x0, int16_t y0, int16_t x1, int16_t y1, uint32_t color, uint8_t thickness) const;
  void text(Segment& segment, const Node& node, const Value* value, uint32_t now) const;
  static uint8_t glyphRow(char character, uint8_t row);
  static uint32_t hsv(uint8_t hue, uint8_t saturation, uint8_t value);
};

} // namespace fpv_display
