#pragma once

#include "fpv_scene.h"

namespace fpv_display {

class Renderer {
public:
  void attach(Scene* scene, DisplayState* state) { _scene = scene; _state = state; }
  void render(WS2812FX& target, uint32_t now, bool drawBackground = true);
  bool isAnimated() const;

private:
  Scene* _scene = nullptr;
  DisplayState* _state = nullptr;

  const Value* findValue(const char* key) const;
  uint32_t nodeColor(const Node& node, const Value* value, int16_t x, int16_t y, uint32_t now) const;
  void motionOffset(const Node& node, uint32_t now, int16_t& offsetX, int16_t& offsetY) const;
  void pixel(WS2812FX& target, int16_t x, int16_t y, uint32_t color) const;
  void rect(WS2812FX& target, int16_t x, int16_t y, int16_t width, int16_t height, uint32_t color, bool filled, uint8_t thickness) const;
  void line(WS2812FX& target, int16_t x0, int16_t y0, int16_t x1, int16_t y1, uint32_t color, uint8_t thickness) const;
  void text(WS2812FX& target, const Node& node, const Value* value, uint32_t now, int16_t offsetX, int16_t offsetY) const;
  static uint8_t glyphRow(char character, uint8_t row);
  static uint32_t hsv(uint8_t hue, uint8_t saturation, uint8_t value);
};

} // namespace fpv_display
