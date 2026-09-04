#include "fpv_storage.h"

namespace fpv_display {

uint32_t SceneStorage::checksum(const uint8_t* data, size_t length) {
  uint32_t result = 2166136261UL;
  for (size_t i = 0; i < length; i++) result = (result ^ data[i]) * 16777619UL;
  return result;
}

void SceneStorage::pathFor(const char* id, char* path, size_t pathSize) {
  uint32_t key = checksum(reinterpret_cast<const uint8_t*>(id), strlen(id));
  snprintf(path, pathSize, "/fpv_%08lx.fpl", static_cast<unsigned long>(key));
}

bool SceneStorage::save(const Scene& scene, char* error, size_t errorSize) const {
  StorageHeader header = {};
  header.magic = MAGIC;
  header.version = STORAGE_VERSION;
  header.payloadSize = sizeof(Scene);
  header.checksum = checksum(reinterpret_cast<const uint8_t*>(&scene), sizeof(Scene));
  copyText(header.id, sizeof(header.id), scene.id);
  copyText(header.hash, sizeof(header.hash), scene.hash);
  header.revision = scene.revision;
  header.nodeCount = scene.nodeCount;

  char path[24], temporary[28];
  pathFor(scene.id, path, sizeof(path));
  snprintf(temporary, sizeof(temporary), "%s.tmp", path);
  File file = WLED_FS.open(temporary, "w");
  if (!file) {
    copyText(error, errorSize, "schema_storage_open_failed");
    return false;
  }
  const size_t headerWritten = file.write(reinterpret_cast<const uint8_t*>(&header), sizeof(header));
  const size_t sceneWritten = file.write(reinterpret_cast<const uint8_t*>(&scene), sizeof(scene));
  file.close();
  if (headerWritten != sizeof(header) || sceneWritten != sizeof(scene)) {
    WLED_FS.remove(temporary);
    copyText(error, errorSize, "schema_storage_write_failed");
    return false;
  }
  WLED_FS.remove(path);
  if (!WLED_FS.rename(temporary, path)) {
    WLED_FS.remove(temporary);
    copyText(error, errorSize, "schema_storage_commit_failed");
    return false;
  }
  return true;
}

bool SceneStorage::load(const char* id, const char* hash, Scene& scene, char* error, size_t errorSize) const {
  char path[24];
  pathFor(id, path, sizeof(path));
  File file = WLED_FS.open(path, "r");
  if (!file) {
    copyText(error, errorSize, "schema_missing");
    return false;
  }
  StorageHeader header = {};
  const size_t headerRead = file.read(reinterpret_cast<uint8_t*>(&header), sizeof(header));
  if (headerRead != sizeof(header) || header.magic != MAGIC || header.version != STORAGE_VERSION || header.payloadSize != sizeof(Scene)) {
    file.close();
    copyText(error, errorSize, "schema_storage_invalid");
    return false;
  }
  const size_t sceneRead = file.read(reinterpret_cast<uint8_t*>(&scene), sizeof(scene));
  file.close();
  if (sceneRead != sizeof(scene) || header.checksum != checksum(reinterpret_cast<const uint8_t*>(&scene), sizeof(Scene))) {
    copyText(error, errorSize, "schema_storage_corrupt");
    return false;
  }
  if (!sameText(id, scene.id) || !sameText(header.id, scene.id)) {
    copyText(error, errorSize, "schema_id_mismatch");
    return false;
  }
  if (hash && hash[0] && !sameText(hash, scene.hash)) {
    copyText(error, errorSize, "schema_hash_mismatch");
    return false;
  }
  return true;
}

void SceneStorage::renderList(Print& output) const {
  File root = WLED_FS.open("/", "r");
  File file = root.openNextFile();
  bool found = false;
  while (file) {
    const String name = file.name();
    if (name.indexOf("fpv_") >= 0 && name.endsWith(".fpl") && file.size() == sizeof(StorageHeader) + sizeof(Scene)) {
      StorageHeader header = {};
      if (file.read(reinterpret_cast<uint8_t*>(&header), sizeof(header)) == sizeof(header) && header.magic == MAGIC) {
        found = true;
        output.print(F("<li><code>")); output.print(header.id);
        output.print(F("</code> &mdash; hash <code>")); output.print(header.hash);
        output.print(F("</code>, revision ")); output.print(header.revision);
        output.print(F(", ")); output.print(header.nodeCount); output.print(F(" nodes</li>"));
      }
    }
    file.close();
    file = root.openNextFile();
  }
  root.close();
  if (!found) output.print(F("<li>No layout schemas installed.</li>"));
}

} // namespace fpv_display
