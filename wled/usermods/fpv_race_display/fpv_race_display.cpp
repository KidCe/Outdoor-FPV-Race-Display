#include "wled.h"
#include "fpv_renderer.h"
#include "fpv_storage.h"

namespace fpv_display {

class FpvRaceDisplayUsermod : public Usermod {
public:
  FpvRaceDisplayUsermod() : _socket("/fpv/ws") {}

  void setup() override {
    _renderer.attach(&_scene, &_state);
    _socket.onEvent([this](AsyncWebSocket* server, AsyncWebSocketClient* client, AwsEventType type, void* arg, uint8_t* data, size_t length) {
      handleSocketEvent(server, client, type, arg, data, length);
    });
    server.addHandler(&_socket);
    registerLayoutRoutes();
    if (_enabled && _configuredSchema[0]) {
      char error[81] = {};
      _active = _storage.load(_configuredSchema, _configuredHash, _scene, error, sizeof(error));
      if (_active) strip.trigger();
    }
  }

  void loop() override {
    const uint32_t now = millis();
    if ((_captureRequested || _captureActive) && now - _captureStartedAt >= CAPTURE_TIMEOUT_MS) releaseCapture();
    if (now - _lastSocketCleanup >= 1000) {
      _lastSocketCleanup = now;
      _socket.cleanupClients();
    }
    if (!_enabled || !_active || !_renderer.isAnimated()) return;
    const uint8_t fps = _scene.fps ? _scene.fps : 1;
    const uint16_t calculated = 1000 / fps;
    const uint16_t interval = calculated < 16 ? 16 : calculated;
    if (now - _lastFrame >= interval) {
      _lastFrame = now;
      strip.trigger();
    }
  }

  void handleOverlayDraw() override {
    if (!_enabled || !_active || !strip.isMatrix) return;
    if (_backgroundEffectPercent == 0) {
      // Clear the complete segment, not only the schema canvas. This also
      // removes stale pixels when matrix dimensions or segments changed.
      strip.fill(_scene.background);
    } else {
      // Preserve only a deliberately small portion of the WLED effect so
      // white race text remains legible outdoors.
      const uint8_t retained = static_cast<uint8_t>((uint16_t(_backgroundEffectPercent) * 255U) / 100U);
      for (uint16_t index = 0; index < strip.getLengthTotal(); index++) {
        strip.setPixelColor(index, color_fade(strip.getPixelColorNoMap(index), retained, true));
      }
    }
    _renderer.render(strip, millis(), false);
    _renderCount++;
    _lastRenderedAt = millis();
    if (_captureRequested) {
      _captureRequested = false;
      _captureActive = true;
      _captureReady = true;
      _captureFrame = _renderCount;
      _captureRenderedAt = _lastRenderedAt;
      // show() continues after this callback and paints this exact frame into
      // the HUB75 bus. Suspending here prevents a later frame replacing it.
      strip.suspend();
    }
  }

  void readFromJsonState(JsonObject& root) override {
    JsonObjectConst command = root["fpv"].as<JsonObjectConst>();
    if (command.isNull()) return;
    CommandReply reply;
    process(command, reply);
    if (serialCanTX) writeReply(Serial, reply);
  }

  void addToJsonState(JsonObject& root) override {
    JsonObject status = root.createNestedObject("fpv");
    status["protocol"] = PROTOCOL_VERSION;
    status["enabled"] = _enabled;
    status["active"] = _active;
    status["schema"] = _scene.id;
    status["hash"] = _scene.hash;
    status["nodes"] = _scene.nodeCount;
    status["brightness"] = _brightnessPercent;
    status["backgroundEffect"] = _backgroundEffectPercent;
    status["renderCount"] = _renderCount;
    status["lastRenderedAt"] = _lastRenderedAt;
    status["captureActive"] = _captureRequested || _captureActive;
  }

  void addToJsonInfo(JsonObject& root) override {
    JsonObject user = root["u"];
    JsonArray info = user.createNestedArray("FPV Race Display");
    info.add(_active ? _scene.id : "inactive");
    info.add(_active ? _scene.hash : "");
  }

  void addToConfig(JsonObject& root) override {
    JsonObject top = root.createNestedObject("FPV Race Display");
    top["enabled"] = _enabled;
    top["schema"] = _configuredSchema;
    top["hash"] = _configuredHash;
    top["backgroundEffect"] = _backgroundEffectPercent;
  }

  bool readFromConfig(JsonObject& root) override {
    JsonObject top = root["FPV Race Display"];
    if (top.isNull()) return false;
    _enabled = top["enabled"] | true;
    copyText(_configuredSchema, sizeof(_configuredSchema), top["schema"] | "");
    copyText(_configuredHash, sizeof(_configuredHash), top["hash"] | "");
    _backgroundEffectPercent = constrain(top["backgroundEffect"] | 0, 0, 25);
    return true;
  }

  void appendConfigData(Print& output) override {
    output.print(F("addInfo('FPV Race Display:enabled',1,'<a class=\"btn btn-xs\" href=\"/fpv-layouts\">Manage layout schemas</a>');"));
    output.print(F("addInfo('FPV Race Display:backgroundEffect',1,'% of WLED effect retained (0-25)');"));
  }

private:
  static constexpr const char* UPLOAD_PATH = "/fpv-layout-upload.json";
  static constexpr uint8_t JSON_LOCK_FPV = 240;
  static constexpr uint32_t CAPTURE_TIMEOUT_MS = 30000;
  bool _enabled = true;
  bool _active = false;
  bool _installing = false;
  uint8_t _brightnessPercent = 50;
  uint8_t _backgroundEffectPercent = 0;
  uint32_t _lastFrame = 0;
  uint32_t _lastSocketCleanup = 0;
  uint32_t _lastSequence = 0;
  uint32_t _renderCount = 0;
  uint32_t _lastRenderedAt = 0;
  uint32_t _captureId = 0;
  uint32_t _captureFrame = 0;
  uint32_t _captureRenderedAt = 0;
  uint32_t _captureStartedAt = 0;
  uint32_t _captureChecksum = 0;
  uint16_t _captureWidth = 0;
  uint16_t _captureHeight = 0;
  uint16_t _captureTotal = 0;
  uint16_t _captureLit = 0;
  bool _captureRequested = false;
  bool _captureActive = false;
  bool _captureReady = false;
  bool _captureMetricsReady = false;
  bool _captureOutput = true;
  bool _captureExact = true;
  char _lastSession[9] = {};
  CommandReply _lastReply;
  char _configuredSchema[ID_SIZE] = {};
  char _configuredHash[HASH_SIZE] = {};
  Scene _scene;
  DisplayState _state;
  Renderer _renderer;
  SceneStorage _storage;
  AsyncWebSocket _socket;
  StaticJsonDocument<2048> _socketDocument;

  uint32_t capturedPixel(uint16_t index) const {
    // WLED's global framebuffer is stored in logical matrix order, while the
    // bus buffer is addressed through the configured LED map. Reading the
    // mapped bus position reconstructs the actual output in screen coordinates.
    return _captureOutput ? BusManager::getPixelColor(strip.getMappedPixelIndex(index)) : strip.getPixelColorNoMap(index);
  }

  void releaseCapture() {
    const bool wasCapturing = _captureRequested || _captureActive;
    _captureRequested = false;
    _captureActive = false;
    _captureReady = false;
    _captureMetricsReady = false;
    if (wasCapturing) {
      strip.resume();
      strip.trigger();
    }
  }

  void calculateCaptureMetrics() {
    if (_captureMetricsReady || !_captureReady) return;
    uint32_t checksum = 2166136261UL;
    uint16_t lit = 0;
    static constexpr uint32_t HUB75_UNKNOWN_LIT = 0x333333UL;
    uint16_t darkGrey = 0;
    uint16_t varied = 0;
    for (uint16_t index = 0; index < _captureTotal; index++) {
      const uint32_t color = capturedPixel(index);
      const uint8_t red = R(color), green = G(color), blue = B(color);
      checksum = (checksum ^ red) * 16777619UL;
      checksum = (checksum ^ green) * 16777619UL;
      checksum = (checksum ^ blue) * 16777619UL;
      if (red || green || blue) lit++;
      if (color == HUB75_UNKNOWN_LIT) darkGrey++;
      if (color && color != HUB75_UNKNOWN_LIT) varied++;
    }
    _captureChecksum = checksum;
    _captureLit = lit;
    // Unbuffered HUB75 builds can only report black/non-black from the bus.
    _captureExact = !_captureOutput || varied > 0 || darkGrey == 0;
    _captureMetricsReady = true;
  }

  void populateFrameMeta(CommandReply& reply) {
    reply.hasFrame = true;
    reply.frameReady = _captureReady;
    reply.frameExact = _captureExact;
    reply.capture = _captureId;
    reply.frame = _captureFrame;
    reply.renderedAt = _captureRenderedAt;
    reply.checksum = _captureChecksum;
    reply.width = _captureWidth;
    reply.height = _captureHeight;
    reply.total = _captureTotal;
    reply.lit = _captureLit;
    copyText(reply.source, sizeof(reply.source), _captureOutput ? "output" : "logical");
  }

  void encodeCaptureChunk(uint16_t offset, uint8_t count, char* output, size_t capacity) const {
    static constexpr char BASE64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t position = 0;
    for (uint8_t index = 0; index < count && position + 4 < capacity; index++) {
      const uint32_t color = capturedPixel(offset + index);
      const uint8_t red = R(color), green = G(color), blue = B(color);
      output[position++] = BASE64[red >> 2];
      output[position++] = BASE64[((red & 0x03) << 4) | (green >> 4)];
      output[position++] = BASE64[((green & 0x0F) << 2) | (blue >> 6)];
      output[position++] = BASE64[blue & 0x3F];
    }
    output[position] = '\0';
  }

  void setReply(CommandReply& reply, bool ok, const char* code, const char* message = "") {
    reply.ok = ok;
    copyText(reply.code, sizeof(reply.code), code);
    copyText(reply.message, sizeof(reply.message), message);
  }

  Value* valueFor(const char* key) {
    if (!key || !key[0]) return nullptr;
    for (uint8_t i = 0; i < _state.valueCount; i++) if (sameText(_state.values[i].key, key)) return &_state.values[i];
    if (_state.valueCount >= MAX_VALUES) return nullptr;
    Value& value = _state.values[_state.valueCount++];
    copyText(value.key, sizeof(value.key), key);
    return &value;
  }

  void applyValues(JsonArrayConst values, bool replace, CommandReply& reply) {
    if (replace) memset(&_state, 0, sizeof(_state));
    for (JsonObjectConst source : values) {
      Value* value = valueFor(source["key"] | "");
      if (!value) {
        setReply(reply, false, "too_many_values");
        return;
      }
      if (source.containsKey("text")) copyText(value->text, sizeof(value->text), source["text"] | "");
      if (source.containsKey("color")) { value->color = parseColor(source["color"]); value->hasColor = true; }
      if (source.containsKey("effect")) { value->effect = parseEffect(source["effect"] | "none"); value->hasEffect = true; }
      if (source.containsKey("visible")) { value->visible = source["visible"] | true; value->hasVisible = true; }
    }
    _active = true;
    strip.trigger();
    setReply(reply, true, "state_applied");
  }

  void applyDisplayControls(JsonObjectConst command) {
    if (command.containsKey("brightness")) {
      _brightnessPercent = constrain(command["brightness"].as<int>(), 0, 100);
      const uint8_t target = static_cast<uint8_t>((uint16_t(_brightnessPercent) * 255U + 50U) / 100U);
      bri = target;
      if (target > 0) briLast = target;
      strip.setBrightness(target, true);
    }
    if (command.containsKey("backgroundEffect")) {
      _backgroundEffectPercent = constrain(command["backgroundEffect"].as<int>(), 0, 25);
    }
  }

  void process(JsonObjectConst command, CommandReply& reply) {
    const uint32_t requestedSequence = command["seq"] | 0;
    const char* requestedSession = command["sid"] | "legacy";
    if (requestedSequence && requestedSequence == _lastSequence && sameText(requestedSession, _lastSession)) {
      reply = _lastReply;
      return;
    }
    processNew(command, reply);
    if (requestedSequence) {
      _lastSequence = requestedSequence;
      copyText(_lastSession, sizeof(_lastSession), requestedSession);
      _lastReply = reply;
    }
  }

  void processNew(JsonObjectConst command, CommandReply& reply) {
    reply.sequence = command["seq"] | 0;
    if ((command["p"] | 0) != PROTOCOL_VERSION) {
      setReply(reply, false, "unsupported_protocol");
      return;
    }
    const char* operation = command["op"] | "";
    if (!strcmp(operation, "hello") || !strcmp(operation, "ping")) {
      setReply(reply, true, "ready");
      return;
    }
    if (!strcmp(operation, "use")) {
      char error[81] = {};
      const char* id = command["schema"] | "";
      const char* hash = command["hash"] | "";
      if (!_storage.load(id, hash, _scene, error, sizeof(error))) {
        _active = false;
        setReply(reply, false, error);
        return;
      }
      memset(&_state, 0, sizeof(_state));
      _active = true;
      copyText(_configuredSchema, sizeof(_configuredSchema), _scene.id);
      copyText(_configuredHash, sizeof(_configuredHash), _scene.hash);
      strip.trigger();
      setReply(reply, true, "schema_ready");
      return;
    }
    if (!strcmp(operation, "state")) {
      if (!_active || !sameText(command["schema"] | "", _scene.id)) {
        setReply(reply, false, "schema_not_active");
        return;
      }
      const char* hash = command["hash"] | "";
      if (hash[0] && !sameText(hash, _scene.hash)) {
        setReply(reply, false, "schema_hash_mismatch");
        return;
      }
      applyDisplayControls(command);
      applyValues(command["values"].as<JsonArrayConst>(), command["replace"] | false, reply);
      return;
    }
    if (!strcmp(operation, "frame.begin")) {
      releaseCapture();
      _captureOutput = strcmp(command["source"] | "output", "logical") != 0;
      _captureWidth = strip.isMatrix ? Segment::maxWidth : strip.getLengthTotal();
      _captureHeight = strip.isMatrix ? Segment::maxHeight : 1;
      const uint32_t matrixPixels = uint32_t(_captureWidth) * _captureHeight;
      const uint32_t stripPixels = strip.getLengthTotal();
      _captureTotal = matrixPixels < stripPixels ? matrixPixels : stripPixels;
      _captureId++;
      if (!_captureId) _captureId = 1;
      _captureFrame = 0;
      _captureRenderedAt = 0;
      _captureChecksum = 0;
      _captureLit = 0;
      _captureExact = true;
      _captureMetricsReady = false;
      _captureReady = false;
      _captureRequested = true;
      _captureStartedAt = millis();
      strip.resume();
      strip.trigger();
      setReply(reply, true, "capture_pending");
      populateFrameMeta(reply);
      return;
    }
    if (!strcmp(operation, "frame.status")) {
      if (!_captureRequested && !_captureActive) {
        setReply(reply, false, "capture_not_active");
        return;
      }
      if (_captureReady && BusManager::canAllShow()) calculateCaptureMetrics();
      setReply(reply, true, _captureReady && _captureMetricsReady ? "capture_ready" : "capture_pending");
      populateFrameMeta(reply);
      return;
    }
    if (!strcmp(operation, "frame.chunk")) {
      const uint32_t requestedCapture = command["capture"] | 0;
      if (!_captureReady || !_captureMetricsReady || requestedCapture != _captureId) {
        setReply(reply, false, _captureReady ? "capture_id_mismatch" : "capture_not_ready");
        return;
      }
      const uint16_t offset = command["offset"] | 0;
      if (offset >= _captureTotal) {
        setReply(reply, false, "frame_offset_out_of_range");
        return;
      }
      const uint8_t requestedCount = constrain(command["count"] | FRAME_CHUNK_PIXELS, 1, FRAME_CHUNK_PIXELS);
      const uint16_t remaining = _captureTotal - offset;
      const uint8_t count = requestedCount < remaining ? requestedCount : remaining;
      setReply(reply, true, "frame_chunk");
      populateFrameMeta(reply);
      reply.offset = offset;
      reply.count = count;
      encodeCaptureChunk(offset, count, reply.data, sizeof(reply.data));
      return;
    }
    if (!strcmp(operation, "frame.end")) {
      releaseCapture();
      setReply(reply, true, "capture_closed");
      return;
    }
    if (!strcmp(operation, "activate")) {
      releaseCapture();
      _active = command["on"] | false;
      strip.trigger();
      setReply(reply, true, _active ? "activated" : "deactivated");
      return;
    }
    if (!strcmp(operation, "schema.begin")) {
      memset(&_scene, 0, sizeof(_scene));
      memset(&_state, 0, sizeof(_state));
      copyText(_scene.id, sizeof(_scene.id), command["schema"] | "");
      copyText(_scene.hash, sizeof(_scene.hash), command["hash"] | "");
      _scene.revision = command["revision"] | 1;
      _scene.width = constrain(command["width"] | 80, 1, 255);
      _scene.height = constrain(command["height"] | 80, 1, 255);
      _scene.background = parseColor(command["background"], 0);
      _scene.fps = constrain(command["fps"] | 30, 1, 60);
      _active = false;
      _installing = _scene.id[0] && _scene.hash[0];
      setReply(reply, _installing, _installing ? "schema_started" : "schema_identity_required");
      return;
    }
    if (!strcmp(operation, "schema.node")) {
      if (!_installing) { setReply(reply, false, "schema_not_started"); return; }
      if (_scene.nodeCount >= MAX_NODES) { setReply(reply, false, "too_many_nodes"); return; }
      char error[81] = {};
      if (!parseNode(command["node"].as<JsonObjectConst>(), _scene.nodes[_scene.nodeCount], error, sizeof(error))) {
        setReply(reply, false, error);
        return;
      }
      _scene.nodeCount++;
      setReply(reply, true, "node_accepted");
      return;
    }
    if (!strcmp(operation, "schema.commit")) {
      if (!_installing || !_scene.nodeCount) { setReply(reply, false, "schema_incomplete"); return; }
      char error[81] = {};
      if (!_storage.save(_scene, error, sizeof(error))) { setReply(reply, false, error); return; }
      _installing = false;
      _active = command["activate"] | true;
      copyText(_configuredSchema, sizeof(_configuredSchema), _scene.id);
      copyText(_configuredHash, sizeof(_configuredHash), _scene.hash);
      configNeedsWrite = true;
      strip.trigger();
      setReply(reply, true, "schema_installed");
      return;
    }
    if (!strcmp(operation, "schema.abort")) {
      _installing = false;
      _active = false;
      setReply(reply, true, "schema_aborted");
      return;
    }
    setReply(reply, false, "unknown_operation");
  }

  void writeReply(Print& output, const CommandReply& reply) {
    StaticJsonDocument<768> document;
    populateReply(document.createNestedObject("fpv"), reply);
    serializeJson(document, output);
    output.println();
  }

  void populateReply(JsonObject fpv, const CommandReply& reply) {
    fpv["p"] = PROTOCOL_VERSION;
    fpv["seq"] = reply.sequence;
    fpv["ok"] = reply.ok;
    fpv["code"] = reply.code;
    if (reply.message[0]) fpv["message"] = reply.message;
    fpv["schema"] = _scene.id;
    fpv["hash"] = _scene.hash;
    fpv["nodes"] = _scene.nodeCount;
    if (reply.hasFrame) {
      fpv["capture"] = reply.capture;
      fpv["ready"] = reply.frameReady;
      fpv["source"] = reply.source;
      fpv["exact"] = reply.frameExact;
      fpv["frame"] = reply.frame;
      fpv["renderedAt"] = reply.renderedAt;
      fpv["width"] = reply.width;
      fpv["height"] = reply.height;
      fpv["total"] = reply.total;
      fpv["lit"] = reply.lit;
      fpv["checksum"] = reply.checksum;
      if (reply.count) {
        fpv["offset"] = reply.offset;
        fpv["count"] = reply.count;
        fpv["data"] = reply.data;
      }
    }
  }

  void handleSocketEvent(AsyncWebSocket*, AsyncWebSocketClient* client, AwsEventType type, void* argument, uint8_t* data, size_t length) {
    if (type != WS_EVT_DATA) return;
    AwsFrameInfo* frame = reinterpret_cast<AwsFrameInfo*>(argument);
    if (!frame->final || frame->index != 0 || frame->len != length || frame->opcode != WS_TEXT || length >= 2048) {
      client->text(F("{\"fpv\":{\"p\":1,\"ok\":false,\"code\":\"message_too_large\"}}"));
      return;
    }
    _socketDocument.clear();
    if (deserializeJson(_socketDocument, data, length)) {
      client->text(F("{\"fpv\":{\"p\":1,\"ok\":false,\"code\":\"invalid_json\"}}"));
      return;
    }
    JsonObjectConst command = _socketDocument["fpv"].as<JsonObjectConst>();
    CommandReply reply;
    if (command.isNull()) setReply(reply, false, "missing_envelope"); else process(command, reply);
    StaticJsonDocument<768> responseDocument;
    populateReply(responseDocument.createNestedObject("fpv"), reply);
    String response;
    response.reserve(512);
    serializeJson(responseDocument, response);
    client->text(response);
  }

  bool installUploadedSchema(char* error, size_t errorSize) {
    JSONBufferGuard guard(JSON_LOCK_FPV);
    if (!guard) { copyText(error, errorSize, "json_buffer_busy"); return false; }
    File file = WLED_FS.open(UPLOAD_PATH, "r");
    if (!file) { copyText(error, errorSize, "upload_missing"); return false; }
    pDoc->clear();
    const DeserializationError jsonError = deserializeJson(*pDoc, file);
    file.close();
    if (jsonError) { copyText(error, errorSize, "invalid_schema_json"); return false; }
    _active = false;
    memset(&_scene, 0, sizeof(_scene));
    if (!parseScene(pDoc->as<JsonObjectConst>(), _scene, error, errorSize)) return false;
    if (!_storage.save(_scene, error, errorSize)) return false;
    memset(&_state, 0, sizeof(_state));
    _active = true;
    copyText(_configuredSchema, sizeof(_configuredSchema), _scene.id);
    copyText(_configuredHash, sizeof(_configuredHash), _scene.hash);
    configNeedsWrite = true;
    strip.trigger();
    return true;
  }

  void registerLayoutRoutes() {
    server.on("/fpv-layouts", HTTP_GET, [this](AsyncWebServerRequest* request) {
      if (!correctPIN) { request->send(401, "text/plain", "Unlock WLED settings first."); return; }
      AsyncResponseStream* response = request->beginResponseStream("text/html");
      response->print(F("<!doctype html><html lang=en><meta name=viewport content='width=device-width'><title>FPV Layout Schemas</title><style>body{font-family:system-ui;background:#111;color:#eee;max-width:760px;margin:30px auto;padding:0 16px}section{background:#1b1b1b;border:1px solid #444;border-radius:10px;padding:16px;margin:16px 0}button,input{font:inherit;padding:9px}code{color:#9df}</style><h1>FPV Race Display layouts</h1><section><h2>Install schema</h2><form method=post enctype=multipart/form-data><input required type=file name=schema accept='.json,application/json'> <button>Upload and activate</button></form><p>The file is validated, compiled to a fixed-size scene and stored in WLED flash.</p></section><section><h2>Installed schemas</h2><ul>"));
      _storage.renderList(*response);
      response->print(F("</ul></section><p><a href='/settings/um'>Back to Usermods settings</a></p></html>"));
      request->send(response);
    });
    server.on("/fpv-layouts", HTTP_POST, [](AsyncWebServerRequest*) {}, [this](AsyncWebServerRequest* request, const String&, size_t index, uint8_t* data, size_t length, bool final) {
      if (!correctPIN) { if (final) request->send(401, "text/plain", "Unlock WLED settings first."); return; }
      if (!index) request->_tempFile = WLED_FS.open(UPLOAD_PATH, "w");
      if (length && request->_tempFile) request->_tempFile.write(data, length);
      if (!final) return;
      if (request->_tempFile) request->_tempFile.close();
      char error[81] = {};
      const bool installed = installUploadedSchema(error, sizeof(error));
      WLED_FS.remove(UPLOAD_PATH);
      if (!installed) request->send(400, "text/plain", String("Schema rejected: ") + error);
      else request->redirect("/fpv-layouts");
    });
  }
};

static FpvRaceDisplayUsermod fpvRaceDisplayUsermod;
REGISTER_USERMOD(fpvRaceDisplayUsermod);

} // namespace fpv_display
