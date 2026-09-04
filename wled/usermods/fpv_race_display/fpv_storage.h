#pragma once

#include "fpv_scene.h"

namespace fpv_display {

class SceneStorage {
public:
  bool save(const Scene& scene, char* error, size_t errorSize) const;
  bool load(const char* id, const char* hash, Scene& scene, char* error, size_t errorSize) const;
  void renderList(Print& output) const;

private:
  struct StorageHeader {
    uint32_t magic;
    uint16_t version;
    uint16_t payloadSize;
    uint32_t checksum;
    char id[ID_SIZE];
    char hash[HASH_SIZE];
    uint16_t revision;
    uint8_t nodeCount;
  };

  static constexpr uint32_t MAGIC = 0x46505631; // FPV1
  static uint32_t checksum(const uint8_t* data, size_t length);
  static void pathFor(const char* id, char* path, size_t pathSize);
};

} // namespace fpv_display
