#pragma once

#include "wled.h"

namespace fpv_display {

static constexpr uint8_t PROTOCOL_VERSION = 1;
static constexpr uint16_t STORAGE_VERSION = 2;
static constexpr uint8_t MAX_NODES = 40;
static constexpr uint8_t MAX_VALUES = 24;
static constexpr uint8_t MAX_POINTS = 12;
static constexpr size_t ID_SIZE = 25;
static constexpr size_t HASH_SIZE = 17;
static constexpr size_t KEY_SIZE = 17;
static constexpr size_t TEXT_SIZE = 41;

enum class NodeType : uint8_t { Text, Rect, Line, Polyline };
enum class Align : uint8_t { Left, Center, Right };
enum class Effect : uint8_t { None, Rainbow, Glitter };

struct Point {
  int16_t x = 0;
  int16_t y = 0;
};

struct Node {
  char id[KEY_SIZE] = {};
  char binding[KEY_SIZE] = {};
  char text[TEXT_SIZE] = {};
  NodeType type = NodeType::Text;
  int16_t x = 0;
  int16_t y = 0;
  int16_t width = 0;
  int16_t height = 0;
  int16_t x2 = 0;
  int16_t y2 = 0;
  uint32_t color = 0xFFFFFF;
  uint8_t fontWidth = 5;
  uint8_t fontHeight = 7;
  uint8_t scale = 1;
  uint8_t thickness = 1;
  Align align = Align::Left;
  Effect effect = Effect::None;
  bool filled = true;
  uint8_t pointCount = 0;
  Point points[MAX_POINTS] = {};
};

struct Scene {
  char id[ID_SIZE] = {};
  char hash[HASH_SIZE] = {};
  uint16_t revision = 0;
  uint16_t width = 80;
  uint16_t height = 80;
  uint32_t background = 0;
  uint8_t fps = 30;
  uint8_t nodeCount = 0;
  Node nodes[MAX_NODES] = {};
};

struct Value {
  char key[KEY_SIZE] = {};
  char text[TEXT_SIZE] = {};
  uint32_t color = 0xFFFFFF;
  Effect effect = Effect::None;
  bool hasColor = false;
  bool hasEffect = false;
};

struct DisplayState {
  uint8_t valueCount = 0;
  Value values[MAX_VALUES] = {};
};

struct CommandReply {
  uint32_t sequence = 0;
  bool ok = false;
  char code[25] = {};
  char message[81] = {};
};

inline void copyText(char* destination, size_t capacity, const char* source) {
  if (!destination || capacity == 0) return;
  strlcpy(destination, source ? source : "", capacity);
}

inline bool sameText(const char* left, const char* right) {
  return strcmp(left ? left : "", right ? right : "") == 0;
}

inline uint32_t parseColor(JsonVariantConst value, uint32_t fallback = 0xFFFFFF) {
  if (value.is<uint32_t>()) return value.as<uint32_t>() & 0xFFFFFF;
  const char* text = value.as<const char*>();
  if (!text) return fallback;
  if (text[0] == '#') text++;
  char* end = nullptr;
  const unsigned long parsed = strtoul(text, &end, 16);
  return end && *end == '\0' ? static_cast<uint32_t>(parsed) & 0xFFFFFF : fallback;
}

inline const char* effectName(Effect effect) {
  switch (effect) {
    case Effect::Rainbow: return "rainbow";
    case Effect::Glitter: return "glitter";
    default: return "none";
  }
}

inline Effect parseEffect(const char* value) {
  if (value && !strcmp(value, "rainbow")) return Effect::Rainbow;
  if (value && !strcmp(value, "glitter")) return Effect::Glitter;
  return Effect::None;
}

inline Align parseAlign(const char* value) {
  if (value && !strcmp(value, "center")) return Align::Center;
  if (value && !strcmp(value, "right")) return Align::Right;
  return Align::Left;
}

inline bool parseNode(JsonObjectConst source, Node& node, char* error, size_t errorSize) {
  const char* type = source["type"] | "text";
  if (!strcmp(type, "text")) node.type = NodeType::Text;
  else if (!strcmp(type, "rect")) node.type = NodeType::Rect;
  else if (!strcmp(type, "line")) node.type = NodeType::Line;
  else if (!strcmp(type, "polyline")) node.type = NodeType::Polyline;
  else {
    copyText(error, errorSize, "unsupported_node_type");
    return false;
  }

  copyText(node.id, sizeof(node.id), source["id"] | "");
  copyText(node.binding, sizeof(node.binding), source["bind"] | "");
  copyText(node.text, sizeof(node.text), source["text"] | "");
  node.x = source["x"] | 0;
  node.y = source["y"] | 0;
  node.width = source["w"] | 0;
  node.height = source["h"] | 0;
  node.x2 = source["x2"] | node.x;
  node.y2 = source["y2"] | node.y;
  node.color = parseColor(source["color"], 0xFFFFFF);
  node.fontWidth = constrain(source["fw"] | 5, 1, 16);
  node.fontHeight = constrain(source["fh"] | 7, 1, 24);
  node.scale = constrain(source["scale"] | 1, 1, 4);
  node.thickness = constrain(source["thickness"] | 1, 1, 4);
  node.align = parseAlign(source["align"] | "left");
  node.effect = parseEffect(source["effect"] | "none");
  node.filled = source["filled"] | true;
  node.pointCount = 0;

  JsonArrayConst points = source["points"].as<JsonArrayConst>();
  for (JsonArrayConst point : points) {
    if (node.pointCount >= MAX_POINTS || point.size() < 2) break;
    node.points[node.pointCount].x = point[0] | 0;
    node.points[node.pointCount].y = point[1] | 0;
    node.pointCount++;
  }

  if (node.type == NodeType::Text && node.width <= 0) {
    copyText(error, errorSize, "text_width_required");
    return false;
  }
  if (node.type == NodeType::Polyline && node.pointCount < 2) {
    copyText(error, errorSize, "polyline_points_required");
    return false;
  }
  return true;
}

inline bool parseScene(JsonObjectConst source, Scene& scene, char* error, size_t errorSize) {
  if (!sameText(source["format"] | "", "wled-fpv-layout")) {
    copyText(error, errorSize, "invalid_schema_format");
    return false;
  }
  if ((source["protocol"] | 0) != PROTOCOL_VERSION) {
    copyText(error, errorSize, "unsupported_protocol");
    return false;
  }

  copyText(scene.id, sizeof(scene.id), source["schemaId"] | "");
  copyText(scene.hash, sizeof(scene.hash), source["schemaHash"] | "");
  scene.revision = source["revision"] | 1;
  JsonObjectConst canvas = source["canvas"].as<JsonObjectConst>();
  scene.width = constrain(canvas["width"] | 80, 1, 255);
  scene.height = constrain(canvas["height"] | 80, 1, 255);
  scene.background = parseColor(canvas["background"], 0);
  scene.fps = constrain(canvas["fps"] | 30, 1, 60);
  scene.nodeCount = 0;

  if (!scene.id[0] || !scene.hash[0]) {
    copyText(error, errorSize, "schema_identity_required");
    return false;
  }

  JsonArrayConst nodes = source["nodes"].as<JsonArrayConst>();
  for (JsonObjectConst nodeObject : nodes) {
    if (scene.nodeCount >= MAX_NODES) {
      copyText(error, errorSize, "too_many_nodes");
      return false;
    }
    if (!parseNode(nodeObject, scene.nodes[scene.nodeCount], error, errorSize)) return false;
    scene.nodeCount++;
  }
  if (!scene.nodeCount) {
    copyText(error, errorSize, "schema_has_no_nodes");
    return false;
  }
  return true;
}

} // namespace fpv_display
