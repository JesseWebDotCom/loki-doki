#include "lokidoki_satellite.h"

#include "esphome/core/log.h"
#include "esphome/core/hal.h"
#include "esphome/core/helpers.h"
#include "esphome/components/json/json_util.h"
#include "esphome/components/network/util.h"
#ifdef USE_LVGL
#include "esphome/components/font/font.h"   // real YAML fonts for the native stream-deck grid
#endif

#include <algorithm>
#include <cstring>

#include <lwip/sockets.h>
#include <lwip/netdb.h>

// LVGL is only present on screen pods (Tab5). Guard so the component still
// compiles for screenless pods (Atom Echo) where LVGL is not pulled in.
#ifdef USE_LVGL
#include <lvgl.h>
#endif

namespace esphome {
namespace lokidoki_satellite {

static const char *const TAG = "lokidoki";

// A claimed device token is 64 hex chars; store it fixed-size in NVS.
struct StoredToken {
  char value[80];
};

// Per-device control state persisted to NVS so it survives reboots/crashes — the user's
// mic mute + audio mute are restored on boot. `magic` guards against reading an unwritten
// slot as a valid (all-zero) struct.
struct StoredSettings {
  uint32_t magic;     // == SETTINGS_MAGIC once written
  bool mic_muted;     // microphone muted (not listening)
  bool audio_muted;   // all speaker output muted
};
static const uint32_t SETTINGS_MAGIC = 0x10D10C01;

// Reconnect backoff and the mic flush threshold (bytes ≈ 32 ms of 16 kHz int16).
static const uint32_t RECONNECT_INTERVAL_MS = 3000;
static const size_t MIC_FLUSH_BYTES = 1024;
// Cap on un-sent outgoing audio (~0.25 s). Past this we drop whole audio frames
// rather than grow the queue without bound when the socket backs up.
static const size_t TX_QUEUE_CAP = 8192;
// Reply playback buffer, sized + driven EXACTLY like Home Assistant's voice_assistant
// (esphome/components/voice_assistant): a FIXED 16 KB block, memcpy in / play()+memmove
// out. Allocated once, never grown — this is what keeps the ESP32 heap stable.
static const size_t RECEIVE_SIZE = 1024;
static const size_t SPEAKER_BUFFER_SIZE = 16 * RECEIVE_SIZE;  // 16384, like HA

void LokiDokiSatellite::setup() {
  this->load_token_();
  this->load_settings_();  // restore mic/audio mute the user set before the last reboot

  // Pre-allocate the fixed playback buffer ONCE — Home-Assistant style (it uses a
  // RAMAllocator<uint8_t> of SPEAKER_BUFFER_SIZE). Never grown, never freed, so the
  // heap stays stable through every reply (the growing buffer is what OOM-crashed).
  RAMAllocator<uint8_t> allocator;
  this->speaker_buffer_ = allocator.allocate(SPEAKER_BUFFER_SIZE);
  if (this->speaker_buffer_ == nullptr) ESP_LOGE(TAG, "speaker buffer alloc failed");

  // Reserve the inbound reassembly buffer ONCE so the bounded read-gate in pump_rx_
  // never triggers a reallocation (the unbounded growth of this vector is what
  // OOM-crashed every reply). 10 KB comfortably exceeds the gate's worst case (~8 KB).
  this->rx_.reserve(RECEIVE_SIZE * 10);

  // The mic runs on its own I2S task; buffer its PCM and flush from loop().
  if (this->mic_ != nullptr) {
    this->mic_->add_data_callback([this](const std::vector<uint8_t> &data) { this->on_mic_data_(data); });
    this->mic_->start();
  }
  // Do NOT start the speaker here. The Atom Echo shares ONE I2S bus between the
  // mic and the speaker, so they can't both own it ("Parent bus is busy"). We run
  // half-duplex: the mic listens continuously, and we hand the bus to the speaker
  // only while a reply is playing (see audio-start/-stop), then give it back.
  this->update_led_();
}

void LokiDokiSatellite::dump_config() {
  ESP_LOGCONFIG(TAG, "Loki Doki satellite:");
  ESP_LOGCONFIG(TAG, "  Host: %s:%u", this->host_.c_str(), this->port_);
  ESP_LOGCONFIG(TAG, "  Model: %s", this->model_.c_str());
  ESP_LOGCONFIG(TAG, "  HWID: %s", this->hwid_().c_str());
  ESP_LOGCONFIG(TAG, "  Paired: %s", this->token_.empty() ? "no (will announce for claim)" : "yes");
}

void LokiDokiSatellite::loop() {
  this->tick_led_();  // keep pulsing states animating in every connection state
  this->tick_dim_();  // idle screen dimming (screen pods with a backlight)

#ifdef USE_LVGL
  if (this->sd_needs_rebuild_) {
    this->sd_needs_rebuild_ = false;
    this->rebuild_stream_deck_ui_();
  }
#endif

  if (!network::is_connected()) {
    if (this->connected_) this->disconnect_("network down");
    return;
  }

  if (!this->connected_) {
    const uint32_t now = millis();
    if (now - this->last_connect_attempt_ < RECONNECT_INTERVAL_MS) return;
    this->last_connect_attempt_ = now;
    if (this->connect_()) {
      this->announce_or_auth_();
      // Single audio-start; then we stream continuously and let the server's
      // wake word gate capture. We never send audio-stop (continuous mode).
      this->send_event_("audio-start", "{\"rate\":16000,\"width\":2,\"channels\":1,\"timestamp\":0}", nullptr, 0);
      this->audio_started_ = true;
    }
    return;
  }

  this->pump_rx_();

  // Half-duplex playback hand-off. The two I2S devices share ONE bus, so the handoff
  // must be strictly sequential: never start one until the other has FULLY stopped,
  // or the ESP-IDF I2S driver abort()s (crash + reset). Everything here is non-blocking.
  if (this->playing_) {
    const bool buf_empty = this->speaker_buffer_size_ == 0;
    const bool spk_empty = (this->speaker_ == nullptr) || !this->speaker_->has_buffered_data();
    const bool drained = buf_empty && spk_empty;
    // End playback only after the server signalled end-of-reply (audio-stop) AND the
    // buffer drained — with a short grace so the last chunk fully plays. A long safety
    // timeout still recovers the mic if the stream dies without an audio-stop.
    const bool done = (this->got_stop_ && drained && (millis() - this->last_play_ms_) > 250)
                   || (drained && (millis() - this->last_play_ms_) > 12000);

    if (!done) {
      // Start the speaker only once the mic has fully released the bus.
      if (this->speaker_ != nullptr && this->speaker_->is_stopped() &&
          (this->mic_ == nullptr || this->mic_->is_stopped())) {
        this->speaker_->start();
        this->speaker_->set_volume(this->muted_ ? 0.0f : 1.0f);
      }
      // Feed the speaker EXACTLY like HA's write_speaker_(): play up to 4 KB from the
      // front of the fixed buffer, then memmove the remainder down. No allocation.
      if (this->speaker_ != nullptr && this->speaker_->is_running() && this->speaker_buffer_size_ > 0) {
        // Track mute live so a toggle mid-reply takes effect (0 volume = silent drain).
        this->speaker_->set_volume(this->muted_ ? 0.0f : 1.0f);
        size_t write_chunk = std::min<size_t>(this->speaker_buffer_size_, 4 * 1024);
        size_t written = this->speaker_->play(this->speaker_buffer_, write_chunk);
        if (written > 0) {
          memmove(this->speaker_buffer_, this->speaker_buffer_ + written, this->speaker_buffer_size_ - written);
          this->speaker_buffer_size_ -= written;
          this->speaker_buffer_index_ -= written;
        }
      }
    } else {
      // Hand the bus back: stop the speaker first, and start the mic ONLY after the
      // speaker is fully stopped (the previous bug: starting the mic immediately
      // raced the speaker's release → I2S abort/crash).
      if (this->speaker_ != nullptr && !this->speaker_->is_stopped()) {
        this->speaker_->stop();
      } else if (this->mic_ != nullptr && this->mic_->is_stopped()) {
        this->mic_->start();
        this->playing_ = false;
        this->speaker_buffer_index_ = 0;
        this->speaker_buffer_size_ = 0;
      } else if (this->mic_ == nullptr) {
        this->playing_ = false;
      }
    }
  }

  // Only stream mic audio up while we actually own the bus (not during playback).
  if (!this->playing_) this->pump_tx_audio_();

  this->flush_tx_();  // push queued bytes out (non-blocking)
}

// ── connection lifecycle ────────────────────────────────────────────────────

bool LokiDokiSatellite::connect_() {
  struct addrinfo hints {};
  hints.ai_family = AF_INET;
  hints.ai_socktype = SOCK_STREAM;
  struct addrinfo *res = nullptr;

  char port_str[8];
  snprintf(port_str, sizeof(port_str), "%u", this->port_);
  if (::getaddrinfo(this->host_.c_str(), port_str, &hints, &res) != 0 || res == nullptr) {
    ESP_LOGW(TAG, "DNS/resolve failed for %s", this->host_.c_str());
    return false;
  }

  int fd = ::socket(res->ai_family, res->ai_socktype, res->ai_protocol);
  if (fd < 0) {
    ESP_LOGW(TAG, "socket() failed");
    ::freeaddrinfo(res);
    return false;
  }
  if (::connect(fd, res->ai_addr, res->ai_addrlen) != 0) {
    ESP_LOGW(TAG, "connect() to %s:%u failed", this->host_.c_str(), this->port_);
    ::close(fd);
    ::freeaddrinfo(res);
    return false;
  }
  ::freeaddrinfo(res);

  // Non-blocking for the data phase so neither reads nor writes ever stall the
  // main loop (a blocking send tripped the task watchdog). Whole frames are queued
  // in tx_buf_ and drained as the socket accepts them (flush_tx_), so the stream
  // never desyncs. TCP_NODELAY keeps audio snappy.
  int flags = ::fcntl(fd, F_GETFL, 0);
  ::fcntl(fd, F_SETFL, flags | O_NONBLOCK);
  int one = 1;
  ::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
  this->tx_buf_.clear();
  this->tx_off_ = 0;

  this->fd_ = fd;
  this->connected_ = true;
  this->audio_started_ = false;
  this->rx_.clear();
  this->update_led_();  // leave the amber "connecting" pulse
  ESP_LOGI(TAG, "connected to gateway %s:%u", this->host_.c_str(), this->port_);
  return true;
}

void LokiDokiSatellite::disconnect_(const char *why) {
  if (this->fd_ >= 0) ::close(this->fd_);
  this->fd_ = -1;
  this->connected_ = false;
  this->audio_started_ = false;
  this->rx_.clear();
  this->rx_off_ = 0;
  this->speaker_buffer_index_ = 0;
  this->speaker_buffer_size_ = 0;
  this->playing_ = false;
  this->update_led_();  // back to the amber "connecting" pulse
  ESP_LOGW(TAG, "disconnected (%s)", why);
}

void LokiDokiSatellite::pump_rx_() {
  // BACKPRESSURE — the key to not OOM-crashing on this tiny chip. We read from the
  // socket ONLY while (a) the reassembly buffer rx_ is small AND (b) the fixed speaker
  // buffer has room. When the speaker is backed up we stop reading; the unread TTS
  // stays in the kernel/peer TCP buffer (TCP slows the server) instead of growing rx_.
  // rx_ has a reserved capacity (setup) and the gate keeps its size under it, so the
  // insert() below NEVER reallocates — that runaway reallocation is what crashed before.
  const size_t rx_pending = this->rx_.size() - this->rx_off_;
  const bool spk_full = this->playing_ && this->speaker_ != nullptr &&
                        this->speaker_buffer_size_ >= (SPEAKER_BUFFER_SIZE - RECEIVE_SIZE);
  if (rx_pending < RECEIVE_SIZE * 4 && !spk_full) {
    uint8_t chunk[RECEIVE_SIZE];
    for (int i = 0; i < 4; i++) {  // ≤ 4 KB per loop
      ssize_t n = ::recv(this->fd_, chunk, sizeof(chunk), MSG_DONTWAIT);
      if (n > 0) {
        this->rx_.insert(this->rx_.end(), chunk, chunk + n);
        if (n < (ssize_t) sizeof(chunk)) break;  // socket drained for now
        continue;
      }
      if (n == 0) { this->disconnect_("peer closed"); return; }
      if (errno == EWOULDBLOCK || errno == EAGAIN) break;
      this->disconnect_("recv error");
      return;
    }
  }

  // Process complete frames. Consume via rx_off_ (offset) instead of erase-from-front.
  //   {"type":..,"data_length":N,"payload_length":M}\n  <N data><M payload>
  for (int processed = 0; processed < 16; processed++) {
    const uint8_t *base = this->rx_.data() + this->rx_off_;
    const size_t avail = this->rx_.size() - this->rx_off_;
    const uint8_t *nl = (const uint8_t *) memchr(base, '\n', avail);
    if (nl == nullptr) break;  // no full header line yet
    const size_t header_len = nl - base;
    std::string header(reinterpret_cast<const char *>(base), header_len);

    std::string type;
    size_t data_len = 0, payload_len = 0;
    json::parse_json(header, [&](JsonObject root) -> bool {
      type = root["type"].as<std::string>();
      data_len = root["data_length"].as<size_t>();
      payload_len = root["payload_length"].as<size_t>();
      return true;
    });

    const size_t need = header_len + 1 + data_len + payload_len;
    if (avail < need) break;  // wait for the rest of the body

    // LOSSLESS speaker backpressure: if this audio chunk won't fit in the fixed buffer
    // yet, leave the whole frame in rx_ and retry next loop (the speaker is draining
    // it). Combined with the read-gate above, rx_ stays bounded and no audio is dropped.
    if (type == "audio-chunk" && this->speaker_buffer_ != nullptr &&
        this->speaker_buffer_index_ + payload_len >= SPEAKER_BUFFER_SIZE) {
      break;
    }

    size_t off = header_len + 1;
    std::string data_json;
    if (data_len > 0) { data_json.assign(reinterpret_cast<const char *>(base + off), data_len); off += data_len; }
    const uint8_t *payload = nullptr;
    if (payload_len > 0) { payload = base + off; off += payload_len; }

    this->process_event_(type, data_json, payload, payload_len);
    this->rx_off_ += need;
  }

  // Reclaim consumed bytes once fully drained or the prefix grows large. erase() keeps
  // the reserved capacity, so this never shrinks/reallocs the buffer.
  if (this->rx_off_ > 0 && (this->rx_off_ >= this->rx_.size() || this->rx_off_ > RECEIVE_SIZE * 4)) {
    this->rx_.erase(this->rx_.begin(), this->rx_.begin() + this->rx_off_);
    this->rx_off_ = 0;
  }
}

void LokiDokiSatellite::pump_tx_audio_() {
  if (!this->audio_started_) return;
  std::vector<uint8_t> out;
  {
    std::lock_guard<std::mutex> lk(this->mic_mtx_);
    if (this->mic_buf_.size() < MIC_FLUSH_BYTES) return;
    out.swap(this->mic_buf_);
  }
  this->send_event_("audio-chunk", "{\"rate\":16000,\"width\":2,\"channels\":1}", out.data(), out.size());
}

// ── Wyoming framing ─────────────────────────────────────────────────────────

void LokiDokiSatellite::send_event_(const char *type, const std::string &data_json,
                                    const uint8_t *payload, size_t payload_len) {
  if (this->fd_ < 0) return;

  std::string header = "{\"type\":\"";
  header += type;
  header += "\"";
  if (!data_json.empty()) {
    header += ",\"data_length\":";
    header += std::to_string(data_json.size());
  }
  if (payload_len > 0) {
    header += ",\"payload_length\":";
    header += std::to_string(payload_len);
  }
  header += "}\n";

  // If the outgoing queue is backed up, DROP this audio frame rather than grow
  // without bound — but only whole frames, so the stream never desyncs. Control
  // frames (auth/audio-start/stop/detection) are always queued.
  const size_t pending = this->tx_buf_.size() - this->tx_off_;
  const bool is_audio = (std::strcmp(type, "audio-chunk") == 0);
  if (is_audio && pending > TX_QUEUE_CAP) return;

  // Append the whole frame to the outgoing queue; flush_tx_() drains it non-blocking.
  this->tx_buf_.insert(this->tx_buf_.end(), header.begin(), header.end());
  this->tx_buf_.insert(this->tx_buf_.end(), data_json.begin(), data_json.end());
  if (payload_len > 0) this->tx_buf_.insert(this->tx_buf_.end(), payload, payload + payload_len);
}

// Drain queued bytes to the socket without ever blocking the main loop.
void LokiDokiSatellite::flush_tx_() {
  if (this->fd_ < 0) return;
  while (this->tx_off_ < this->tx_buf_.size()) {
    ssize_t n = ::send(this->fd_, this->tx_buf_.data() + this->tx_off_,
                       this->tx_buf_.size() - this->tx_off_, MSG_DONTWAIT);
    if (n > 0) { this->tx_off_ += (size_t) n; continue; }
    if (n < 0 && (errno == EWOULDBLOCK || errno == EAGAIN)) break;  // try again next loop
    this->disconnect_("send error");
    return;
  }
  if (this->tx_off_ >= this->tx_buf_.size()) {  // fully drained — reclaim everything
    this->tx_buf_.clear();
    this->tx_off_ = 0;
  } else if (this->tx_off_ > TX_QUEUE_CAP) {
    // CRITICAL: reclaim the already-SENT prefix even when not fully drained. Under
    // continuous mic streaming the queue never empties (the mic always adds more), so
    // the sent prefix used to accumulate forever → heap exhaustion → std::bad_alloc
    // → reboot loop a few seconds after the mic goes live. Compact like pump_rx_ does.
    this->tx_buf_.erase(this->tx_buf_.begin(), this->tx_buf_.begin() + this->tx_off_);
    this->tx_off_ = 0;
  }
}

void LokiDokiSatellite::process_event_(const std::string &type, const std::string &data_json,
                                       const uint8_t *payload, size_t payload_len) {
  if (type == "audio-chunk") {
    // After Stop we discard the rest of THIS reply's audio (still draining out of the
    // socket) so playback halts immediately instead of playing out the backlog.
    if (this->discard_reply_audio_) return;
    // Copy reply audio into the fixed buffer EXACTLY like HA's on_audio(): memcpy at the
    // write head if it fits, else drop the chunk. Socket backpressure (pump_rx_) keeps the
    // server from outrunning us, so in practice the buffer never overflows.
    if (this->speaker_buffer_ != nullptr && payload != nullptr && payload_len > 0) {
      if (this->speaker_buffer_index_ + payload_len < SPEAKER_BUFFER_SIZE) {
        memcpy(this->speaker_buffer_ + this->speaker_buffer_index_, payload, payload_len);
        this->speaker_buffer_index_ += payload_len;
        this->speaker_buffer_size_ += payload_len;
      }
    }
    this->last_play_ms_ = millis();
    return;
  }
  if (type == "audio-start") {
    // Reply incoming: release the shared I2S bus from the mic. The speaker is
    // started in loop() only AFTER the mic has fully stopped (avoids the bus race).
    if (this->mic_ != nullptr) this->mic_->stop();
    this->playing_ = true;
    this->got_stop_ = false;  // new reply — wait for its audio-stop, not just a gap
    this->discard_reply_audio_ = false;  // a fresh reply plays normally again
    this->last_play_ms_ = millis();
    return;
  }
  if (type == "audio-stop") {
    // The server has sent the WHOLE reply. Only now may loop() end playback (once the
    // buffer drains). Before this, gaps between sentences (the server synthesizing the
    // next one) must NOT end playback, or long replies get cut off.
    this->got_stop_ = true;
    this->last_play_ms_ = millis();
    return;
  }
  if (type == "user-event") {
    std::string name, state, token, mode, reply;
    bool dim_enabled = false;
    int dim_percent = 30, dim_after_s = 60, degrees = -1;
    json::parse_json(data_json, [&](JsonObject root) -> bool {
      name = root["name"].as<std::string>();
      state = root["state"].as<std::string>();
      token = root["token"].as<std::string>();
      mode = root["mode"].as<std::string>();  // "" when absent (face.state/auth events)
      reply = root["text"].as<std::string>(); // companion reply text (text-only mode)
      if (root["dimEnabled"].is<bool>()) dim_enabled = root["dimEnabled"].as<bool>();
      if (root["dimPercent"].is<int>()) dim_percent = root["dimPercent"].as<int>();
      if (root["dimAfterS"].is<int>()) dim_after_s = root["dimAfterS"].as<int>();
      if (root["degrees"].is<int>()) degrees = root["degrees"].as<int>();
      return true;
    });
    if (name == "reply_text") {
      // Companion's typed reply — surface it to the LVGL panel via the text sensor.
      if (this->reply_sensor_ != nullptr) this->reply_sensor_->publish_state(reply);
    } else if (name == "face.state") {
      this->face_ = state;
      this->update_led_();
    } else if (name == "auth" && !token.empty()) {
      // The admin just Claimed us — persist the token for next boot.
      this->token_ = token;
      this->save_token_(token);
      ESP_LOGI(TAG, "claimed — token stored");
    } else if (name == "config") {
      // Central settings pushed from the server (on connect + on group change).
      this->dim_enabled_ = dim_enabled;
      this->dim_percent_ = (uint8_t) std::max(0, std::min(100, dim_percent));
      this->dim_after_ms_ = (uint32_t) std::max(1, dim_after_s) * 1000UL;
      this->last_active_ms_ = millis();  // re-evaluate the dim timer from now
      ESP_LOGI(TAG, "config: dim=%d %d%% after %ds", dim_enabled, dim_percent, dim_after_s);
    } else if (name == "display.orientation" && degrees >= 0) {
      // Rotate the LVGL display so native controls (mic/audio/status) and touch
      // coordinates track the physical mounting orientation of the device. The Tab5
      // physical panel is 720×1280 portrait; LVGL rotation=90 is the landscape-normal
      // baseline (set in the YAML).
      //
      // Landscape modes only — portrait (90°/270°) is handled server-side (the server
      // Canvas-rotates the JPEG to 1280×720 so the hw_jpeg decoder gets a fixed-size
      // frame; LVGL stays at its baseline 90° for those modes).
      //   0°  (landscape normal)  → LV_DISPLAY_ROTATION_90  (baseline — no change)
      //   180°(landscape flipped) → LV_DISPLAY_ROTATION_270 (upside-down landscape)
#ifdef USE_LVGL
      // DO NOT rotate the LVGL display at runtime. Proven on the Tab5 (ESP32-P4 MIPI-DSI):
      // calling lv_display_set_rotation() on a live screen corrupts the framebuffer (a
      // scrambled band that the static background never repaints away). The display's
      // orientation is set ONCE at boot by the YAML `lvgl: rotation:` (driver-level), which
      // renders cleanly; this runtime push is therefore redundant AND destructive, so we
      // only log it. Changing orientation requires a reflash with the right YAML rotation
      // (the proper fix is to inject it as a build-time substitution from device.orientation
      // — like the Wi-Fi creds — so each device boots already-oriented; TODO).
      ESP_LOGI(TAG, "display.orientation: %d° received (runtime rotation disabled — set at boot)", degrees);
#endif
    }
    // Screen mode — carried on `config` (restored on (re)connect) or pushed live as
    // a `display.mode` event from the admin Testing tab. Mirror it to the mode sensor
    // so the LVGL layer can switch pages (normal clock / camera test / touch test).
    if (this->mode_sensor_ != nullptr && !mode.empty() && mode != this->published_mode_ &&
        (name == "config" || name == "display.mode")) {
      this->published_mode_ = mode;
      this->mode_sensor_->publish_state(mode);
      ESP_LOGI(TAG, "display mode → %s", mode.c_str());
    }
    // TODO(tab5-slot-ui): the server now also pushes these user-events (see
    // plans/hardware-devices/tab5-slot-ui.md for the full payloads):
    //   name == "layout"      → place/size/theme the 3×3 widgets + cache the sound map
    //   name == "sound"       → play the cached earcon for data["event"] (off-LVGL task)
    //   name == "asset_sync"  → fetch data["files"][].url to SD (verify sha256)
    //   name == "alarm_fire"  → alarm screen + loop data["tone_url"] at alarm volume
    //   name == "alarm_stop"  → coordinated dismiss (stop the loop)
    // And device → server: { name:"alarm_action", alarm_id, action:"snooze"|"cancel" }.
    if (name == "stream_deck_config" && this->sd_page_ != nullptr) {
      this->handle_stream_deck_config_(data_json);
    }
    // ── NATIVE LVGL experiment ──────────────────────────────────────────────────
    // The `layout` descriptor carries a `renderer` ("lvgl" → draw the dashboard
    // natively; "jpeg" → blit the server frame). Surface it to render_sensor_ so the
    // LVGL layer switches render paths. We don't parse the whole descriptor here — for
    // the experiment the native page is themed in YAML; only the mode matters.
    if (name == "layout" && this->render_sensor_ != nullptr) {
      std::string renderer;
      json::parse_json(data_json, [&](JsonObject root) -> bool {
        renderer = root["renderer"].as<std::string>();
        return true;
      });
      if (renderer.empty()) renderer = "jpeg";
      if (renderer != this->published_render_) {
        this->published_render_ = renderer;
        this->render_sensor_->publish_state(renderer);
        ESP_LOGI(TAG, "render mode → %s", renderer.c_str());
      }
    }
    // The live data feed (weather + photo state) for the native dashboard — pass the
    // JSON straight through to data_sensor_; the LVGL layer parses + renders it.
    if (name == "display.data" && this->data_sensor_ != nullptr) {
      this->data_sensor_->publish_state(data_json);
    }
    return;
  }
  // transcript / detection / info: nothing to do on a screenless Pod.
}

// ── identity ────────────────────────────────────────────────────────────────

void LokiDokiSatellite::announce_or_auth_() {
  if (!this->token_.empty()) {
    std::string data = "{\"name\":\"auth\",\"token\":\"" + this->token_ + "\"}";
    this->send_event_("user-event", data, nullptr, 0);
    ESP_LOGI(TAG, "authenticating with stored token");
  } else {
    std::string data = "{\"name\":\"hello\",\"hwid\":\"" + this->hwid_() +
                       "\",\"model\":\"" + this->model_ + "\"}";
    this->send_event_("user-event", data, nullptr, 0);
    ESP_LOGI(TAG, "announcing for claim (hwid %s)", this->hwid_().c_str());
  }
  // Tell the server our current reply mode (voice/text) so it speaks or types replies.
  this->send_reply_mode_();
}

void LokiDokiSatellite::send_reply_mode_() {
  if (!this->connected_) return;
  std::string m = this->voice_reply_ ? "voice" : "text";
  this->send_event_("user-event", std::string("{\"name\":\"reply_mode\",\"mode\":\"") + m + "\"}", nullptr, 0);
}

void LokiDokiSatellite::toggle_mic_mute() {
  // SOFTWARE mute only: on_mic_data_ drops every sample while !mic_enabled_, so nothing
  // is ever buffered or transmitted (no wake, no PTT) — a real functional mute. We do
  // NOT stop the mic peripheral: touching the shared I2S bus outside the playback
  // handoff reboots the device (that's what crashed when tapping the mic).
  this->mic_enabled_ = !this->mic_enabled_;
  this->save_settings_();
  ESP_LOGI(TAG, "microphone %s", this->mic_enabled_ ? "live" : "MUTED (privacy)");
}

std::string LokiDokiSatellite::hwid_() const { return get_mac_address_pretty(); }

void LokiDokiSatellite::load_token_() {
  this->token_pref_ = global_preferences->make_preference<StoredToken>(fnv1_hash("lokidoki_token"));
  StoredToken st{};
  if (this->token_pref_.load(&st)) {
    st.value[sizeof(st.value) - 1] = '\0';
    this->token_ = std::string(st.value);
  }
}

void LokiDokiSatellite::save_token_(const std::string &token) {
  StoredToken st{};
  std::strncpy(st.value, token.c_str(), sizeof(st.value) - 1);
  this->token_pref_.save(&st);
  global_preferences->sync();
}

void LokiDokiSatellite::load_settings_() {
  this->settings_pref_ = global_preferences->make_preference<StoredSettings>(fnv1_hash("lokidoki_settings"));
  StoredSettings s{};
  if (this->settings_pref_.load(&s) && s.magic == SETTINGS_MAGIC) {
    this->mic_enabled_ = !s.mic_muted;
    this->muted_ = s.audio_muted;
    this->voice_reply_ = !s.audio_muted;  // audio off → type-only replies
    ESP_LOGI(TAG, "restored settings: mic %s, audio %s",
             this->mic_enabled_ ? "live" : "MUTED", this->muted_ ? "MUTED" : "on");
  }
}

void LokiDokiSatellite::save_settings_() {
  StoredSettings s{};
  s.magic = SETTINGS_MAGIC;
  s.mic_muted = !this->mic_enabled_;
  s.audio_muted = this->muted_;
  this->settings_pref_.save(&s);
  global_preferences->sync();
}

// ── feedback ────────────────────────────────────────────────────────────────

// LED legend (kept in sync with the app's "How to use" sheet):
//   amber, breathing → connecting / not reaching the Host
//   dim white, steady → connected & idle (waiting for "Hey Jarvis")
//   green, steady    → listening to you
//   blue, breathing  → thinking
//   cyan, steady     → speaking
void LokiDokiSatellite::update_led_() {
  // Mirror the conversation state to the optional screen text sensor (Tab5 LVGL).
  // De-duped so we only publish on a real change. Screen shows "connecting" until
  // the gateway is up, then idle/listening/thinking/talking.
  if (this->face_sensor_ != nullptr) {
    const std::string face = !this->connected_ ? "connecting" : this->face_;
    if (face != this->published_face_) {
      this->published_face_ = face;
      this->face_sensor_->publish_state(face);
    }
  }
  if (this->light_ == nullptr) return;
  float r = 1, g = 1, b = 1, base = 0.10f;
  bool pulse = false;
  if (!this->connected_) {                 // can't reach the Host yet
    r = 1.0f; g = 0.5f; b = 0.0f; base = 0.7f; pulse = true;      // amber
  } else if (this->face_ == "listening") {
    r = 0.0f; g = 1.0f; b = 0.0f; base = 0.85f;                   // green
  } else if (this->face_ == "thinking") {
    r = 0.1f; g = 0.3f; b = 1.0f; base = 0.7f; pulse = true;      // blue
  } else if (this->face_ == "talking") {
    r = 0.0f; g = 1.0f; b = 1.0f; base = 0.8f;                    // cyan
  } else {                                 // idle/connected, waiting for wake
    r = 0.6f; g = 0.8f; b = 1.0f; base = 0.25f;                   // soft blue-white
  }
  this->led_r_ = r; this->led_g_ = g; this->led_b_ = b;
  this->led_base_ = base; this->led_pulse_ = pulse;

  auto call = this->light_->turn_on();
  call.set_rgb(r, g, b);
  call.set_brightness(base);
  call.set_transition_length(pulse ? 0 : 150);  // pulse is animated in tick_led_
  call.perform();
}

void LokiDokiSatellite::tick_led_() {
  if (this->light_ == nullptr || !this->led_pulse_) return;
  const uint32_t now = millis();
  if (now - this->led_last_ < 60) return;     // ~16 fps is plenty for a breathe
  this->led_last_ = now;
  const float phase = (now % 1600) / 1600.0f; // 1.6 s breathe
  const float tri = phase < 0.5f ? phase * 2.0f : (1.0f - phase) * 2.0f;
  auto call = this->light_->turn_on();
  call.set_rgb(this->led_r_, this->led_g_, this->led_b_);
  call.set_brightness(this->led_base_ * (0.25f + 0.75f * tri));
  call.set_transition_length(0);
  call.perform();
}

// Idle screen dimming. Any conversation activity (or a fresh config push) resets the
// idle timer; after dim_after_ms_ of nothing, fade the backlight to dim_percent_, and
// snap back to full on the next activity. No-op without a backlight (screenless pods).
void LokiDokiSatellite::tick_dim_() {
  if (this->backlight_ == nullptr) return;
  const uint32_t now = millis();
  // Conversation activity keeps the screen awake.
  if (this->face_ == "listening" || this->face_ == "thinking" || this->face_ == "talking")
    this->last_active_ms_ = now;
  // ANY touch (a tap on a controller button, a swipe, etc.) also keeps it awake — LVGL
  // tracks input idle time and resets it on every touch, so a tap undims + restarts the timer.
#ifdef USE_LVGL
  if (lv_display_get_inactive_time(NULL) < 500) this->last_active_ms_ = now;
#endif

  if (!this->dim_enabled_) {
    if (this->dimmed_) { this->apply_backlight_(1.0f); this->dimmed_ = false; }
    return;
  }
  const bool should_dim = (now - this->last_active_ms_) > this->dim_after_ms_;
  if (should_dim && !this->dimmed_) {
    this->apply_backlight_(this->dim_percent_ / 100.0f);
    this->dimmed_ = true;
  } else if (!should_dim && this->dimmed_) {
    this->apply_backlight_(1.0f);
    this->dimmed_ = false;
  }
}

void LokiDokiSatellite::apply_backlight_(float brightness) {
  if (this->backlight_ == nullptr) return;
  auto call = this->backlight_->turn_on();
  call.set_brightness(brightness < 0.02f ? 0.02f : brightness);  // never fully black
  call.set_transition_length(600);
  call.perform();
}

void LokiDokiSatellite::button_down() {
  if (!this->connected_) return;
  // Push-to-talk: ask the Host to start capturing now (same path as a wake hit).
  this->face_ = "listening";
  this->update_led_();
  this->send_event_("detection", "{\"name\":\"button\"}", nullptr, 0);
}

void LokiDokiSatellite::button_up() {
  if (!this->connected_) return;
  this->send_event_("audio-stop", "{\"timestamp\":0}", nullptr, 0);
}

void LokiDokiSatellite::on_mic_data_(const std::vector<uint8_t> &data) {
  // mic_enabled_ false → drop mic audio so nothing reaches the server (wake word off).
  if (!this->connected_ || this->playing_ || data.empty() || !this->mic_enabled_) return;
  std::lock_guard<std::mutex> lk(this->mic_mtx_);
  // Cap the backlog small — heap is precious on this chip. ~0.25 s; older audio is
  // dropped if the uplink stalls.
  if (this->mic_buf_.size() > 8000) this->mic_buf_.clear();
  this->mic_buf_.insert(this->mic_buf_.end(), data.begin(), data.end());
}

// ── Stream Deck ─────────────────────────────────────────────────────────────

#ifdef USE_LVGL

namespace {
// Per-button LVGL event callback user data. Heap-allocated on each config push,
// freed on the next rebuild. Stored in sd_btn_ctxs_ as void* to keep lv_obj_t
// out of the header (so the component compiles on screenless pods without LVGL).
struct SdBtnCtx {
  LokiDokiSatellite *self;
  std::string page_id;
  int row, col;
};

static void sd_btn_event_cb(lv_event_t *e) {
  if (lv_event_get_code(e) != LV_EVENT_CLICKED) return;
  auto *ctx = static_cast<SdBtnCtx *>(lv_event_get_user_data(e));
  if (ctx) ctx->self->send_button_press_(ctx->page_id, ctx->row, ctx->col);
}
}  // namespace

void LokiDokiSatellite::handle_stream_deck_config_(const std::string &data_json) {
  // Parse pages array from the Wyoming data JSON.
  // data_json was extracted from the `data` field of the event, so it already
  // has the stream_deck_config payload. We pull "pages" from it.
  this->sd_pages_.clear();

  // Use ESPHome's ArduinoJson wrapper (already pulled in by json/json_util.h).
  DynamicJsonDocument doc(32768);
  DeserializationError err = deserializeJson(doc, data_json);
  if (err) {
    ESP_LOGW(TAG, "[stream-deck] failed to parse config: %s", err.c_str());
    return;
  }

  JsonArray pages = doc["pages"];
  if (!pages) {
    ESP_LOGW(TAG, "[stream-deck] no pages in config");
    return;
  }

  for (JsonObject page : pages) {
    SdPage p;
    p.id = page["id"] | "";
    p.name = page["name"] | "";
    p.grid_rows = page["gridRows"] | 3;
    p.grid_cols = page["gridCols"] | 5;
    JsonArray btns = page["buttons"];
    if (btns) {
      for (JsonObject b : btns) {
        SdButton btn;
        btn.id = b["id"] | "";
        btn.row = b["row"] | 0;
        btn.col = b["col"] | 0;
        btn.icon = b["icon"] | "";
        btn.label = b["label"] | "";
        // Parse hex colors (#rrggbb → uint32).
        const char *bg = b["bgColor"] | "#1e1e2e";
        const char *fg = b["textColor"] | "#ffffff";
        btn.bg_color = (uint32_t) strtol(bg + (bg[0] == '#' ? 1 : 0), nullptr, 16);
        btn.text_color = (uint32_t) strtol(fg + (fg[0] == '#' ? 1 : 0), nullptr, 16);
        p.buttons.push_back(std::move(btn));
      }
    }
    this->sd_pages_.push_back(std::move(p));
  }

  ESP_LOGI(TAG, "[stream-deck] config: %d pages", (int) this->sd_pages_.size());
  this->sd_active_page_ = 0;
  this->sd_needs_rebuild_ = true;
}

void LokiDokiSatellite::rebuild_stream_deck_ui_() {
  lv_obj_t *page = static_cast<lv_obj_t *>(this->sd_page_);
  if (!page) return;

  // Free previous button context objects.
  for (void *p : this->sd_btn_ctxs_) delete static_cast<SdBtnCtx *>(p);
  this->sd_btn_ctxs_.clear();

  // Remove all previous children from the page.
  lv_obj_clean(page);

  if (this->sd_pages_.empty()) return;
  if (this->sd_active_page_ >= (int) this->sd_pages_.size()) this->sd_active_page_ = 0;
  const SdPage &p = this->sd_pages_[this->sd_active_page_];

  // Panel dimensions: 1280×720 landscape (LVGL coords after 90° rotation).
  const int W = 1280, H = 720;
  const int GUTTER = 10;
  const int cell_w = (W - GUTTER * (p.grid_cols + 1)) / p.grid_cols;
  const int cell_h = (H - GUTTER * (p.grid_rows + 1)) / p.grid_rows;
  // The bottom row is reserved for the native mic/sound/player band (page_clock siblings),
  // so the grid only renders rows 0..grid_rows-2.
  const int drawn_rows = p.grid_rows > 1 ? p.grid_rows - 1 : p.grid_rows;
  // Real YAML fonts (passed in as void* → font::Font*), falling back to the tiny built-in.
  const lv_font_t *text_font = this->sd_text_font_
    ? static_cast<font::Font *>(this->sd_text_font_)->get_lv_font() : LV_FONT_DEFAULT;

  // Scale an RGB hex by pct (>100 lightens, <100 darkens), clamping each channel.
  auto shade = [](uint32_t c, int pct) -> uint32_t {
    auto ch = [pct](uint32_t v) -> uint32_t { uint32_t r = v * pct / 100; return r > 255 ? 255 : r; };
    return (ch((c >> 16) & 0xff) << 16) | (ch((c >> 8) & 0xff) << 8) | ch(c & 0xff);
  };

  for (const SdButton &btn : p.buttons) {
    if (btn.row < 0 || btn.row >= drawn_rows || btn.col < 0 || btn.col >= p.grid_cols) continue;

    const int x = GUTTER + btn.col * (cell_w + GUTTER);
    const int y = GUTTER + btn.row * (cell_h + GUTTER);

    lv_obj_t *cell = lv_button_create(page);   // a real button → reliably fires LV_EVENT_CLICKED
    lv_obj_set_pos(cell, x, y);
    lv_obj_set_size(cell, cell_w, cell_h);
    // Glossy convex fill: lighter top → darker bottom, with a bright top edge.
    lv_obj_set_style_bg_color(cell, lv_color_hex(shade(btn.bg_color, 138)), 0);
    lv_obj_set_style_bg_grad_color(cell, lv_color_hex(shade(btn.bg_color, 68)), 0);
    lv_obj_set_style_bg_grad_dir(cell, LV_GRAD_DIR_VER, 0);
    lv_obj_set_style_bg_opa(cell, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(cell, 16, 0);
    lv_obj_set_style_border_width(cell, 1, 0);
    lv_obj_set_style_border_color(cell, lv_color_hex(shade(btn.bg_color, 165)), 0);
    lv_obj_set_style_border_opa(cell, 140, 0);
    lv_obj_set_style_pad_all(cell, 0, 0);
    // Raised: soft drop shadow beneath the tile.
    lv_obj_set_style_shadow_width(cell, 14, 0);
    lv_obj_set_style_shadow_color(cell, lv_color_hex(0x000000), 0);
    lv_obj_set_style_shadow_opa(cell, 95, 0);
    lv_obj_set_style_shadow_ofs_y(cell, 6, 0);
    // Depressed on press: sink down, collapse the shadow, darken the fill.
    lv_obj_set_style_translate_y(cell, 4, LV_STATE_PRESSED);
    lv_obj_set_style_shadow_width(cell, 3, LV_STATE_PRESSED);
    lv_obj_set_style_shadow_ofs_y(cell, 1, LV_STATE_PRESSED);
    lv_obj_set_style_bg_color(cell, lv_color_hex(shade(btn.bg_color, 82)), LV_STATE_PRESSED);
    lv_obj_set_style_bg_grad_color(cell, lv_color_hex(shade(btn.bg_color, 50)), LV_STATE_PRESSED);
    lv_obj_add_flag(cell, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_clear_flag(cell, LV_OBJ_FLAG_SCROLLABLE);

    // Glass sheen: a white highlight over the top, fading to transparent (LVGL 9 grad opa).
    lv_obj_t *sheen = lv_obj_create(cell);
    lv_obj_remove_flag(sheen, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_remove_flag(sheen, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_size(sheen, cell_w - 4, cell_h * 48 / 100);
    lv_obj_align(sheen, LV_ALIGN_TOP_MID, 0, 1);
    lv_obj_set_style_bg_color(sheen, lv_color_hex(0xffffff), 0);
    lv_obj_set_style_bg_grad_color(sheen, lv_color_hex(0xffffff), 0);
    lv_obj_set_style_bg_grad_dir(sheen, LV_GRAD_DIR_VER, 0);
    lv_obj_set_style_bg_opa(sheen, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_main_opa(sheen, 75, 0);   // bright at the very top
    lv_obj_set_style_bg_grad_opa(sheen, 0, 0);    // → fully transparent at the band bottom
    lv_obj_set_style_border_width(sheen, 0, 0);
    lv_obj_set_style_radius(sheen, 15, 0);
    lv_obj_set_style_pad_all(sheen, 0, 0);

    // Label along the BOTTOM of the tile (the top is for the artwork).
    if (!btn.label.empty()) {
      lv_obj_t *lbl = lv_label_create(cell);
      lv_label_set_text(lbl, btn.label.c_str());
      lv_obj_set_style_text_font(lbl, text_font, 0);
      lv_obj_set_style_text_color(lbl, lv_color_hex(btn.text_color), 0);
      lv_obj_set_style_text_align(lbl, LV_TEXT_ALIGN_CENTER, 0);
      lv_obj_set_style_text_opa(lbl, LV_OPA_COVER, 0);
      lv_obj_set_width(lbl, cell_w - 16);
      lv_label_set_long_mode(lbl, LV_LABEL_LONG_DOT);
      lv_obj_align(lbl, LV_ALIGN_BOTTOM_MID, 0, -8);
    }

    // Attach click event with per-button context.
    auto *ctx = new SdBtnCtx{this, p.id, btn.row, btn.col};
    this->sd_btn_ctxs_.push_back(ctx);
    lv_obj_add_event_cb(cell, sd_btn_event_cb, LV_EVENT_CLICKED, ctx);
  }

  // Empty cells (no button configured) — show a dim placeholder. Skip the reserved row.
  for (int r = 0; r < drawn_rows; r++) {
    for (int c = 0; c < p.grid_cols; c++) {
      bool has_btn = false;
      for (const SdButton &btn : p.buttons)
        if (btn.row == r && btn.col == c) { has_btn = true; break; }
      if (has_btn) continue;

      const int x = GUTTER + c * (cell_w + GUTTER);
      const int y = GUTTER + r * (cell_h + GUTTER);
      lv_obj_t *empty = lv_obj_create(page);
      lv_obj_set_pos(empty, x, y);
      lv_obj_set_size(empty, cell_w, cell_h);
      lv_obj_set_style_bg_color(empty, lv_color_hex(0x1a1a2a), 0);
      lv_obj_set_style_bg_opa(empty, LV_OPA_COVER, 0);
      lv_obj_set_style_radius(empty, 12, 0);
      lv_obj_set_style_border_color(empty, lv_color_hex(0x333355), 0);
      lv_obj_set_style_border_width(empty, 1, 0);
      lv_obj_clear_flag(empty, (lv_obj_flag_t) (LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE));
    }
  }

  ESP_LOGI(TAG, "[stream-deck] rebuilt UI: page=%s %dx%d", p.id.c_str(), p.grid_rows, p.grid_cols);
}

#endif  // USE_LVGL

void LokiDokiSatellite::send_button_press_(const std::string &page_id, int row, int col) {
  char buf[256];
  snprintf(buf, sizeof(buf),
           "{\"name\":\"button_press\",\"page_id\":\"%s\",\"row\":%d,\"col\":%d}",
           page_id.c_str(), row, col);
  this->send_event_("user-event", std::string(buf), nullptr, 0);
  ESP_LOGI(TAG, "[stream-deck] button_press page=%s (%d,%d)", page_id.c_str(), row, col);
}

}  // namespace lokidoki_satellite
}  // namespace esphome
