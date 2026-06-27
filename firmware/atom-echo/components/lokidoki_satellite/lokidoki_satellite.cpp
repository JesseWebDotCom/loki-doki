#include "lokidoki_satellite.h"

#include "esphome/core/log.h"
#include "esphome/core/hal.h"
#include "esphome/core/helpers.h"
#include "esphome/components/json/json_util.h"
#include "esphome/components/network/util.h"

#include <algorithm>
#include <cstring>

#include <lwip/sockets.h>
#include <lwip/netdb.h>

namespace esphome {
namespace lokidoki_satellite {

static const char *const TAG = "lokidoki";

// A claimed device token is 64 hex chars; store it fixed-size in NVS.
struct StoredToken {
  char value[80];
};

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
    const bool done = buf_empty && spk_empty && (millis() - this->last_play_ms_) > 700;

    if (!done) {
      // Start the speaker only once the mic has fully released the bus.
      if (this->speaker_ != nullptr && this->speaker_->is_stopped() &&
          (this->mic_ == nullptr || this->mic_->is_stopped())) {
        this->speaker_->start();
        this->speaker_->set_volume(1.0f);  // ensure full software volume
      }
      // Feed the speaker EXACTLY like HA's write_speaker_(): play up to 4 KB from the
      // front of the fixed buffer, then memmove the remainder down. No allocation.
      if (this->speaker_ != nullptr && this->speaker_->is_running() && this->speaker_buffer_size_ > 0) {
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
  if (this->tx_off_ >= this->tx_buf_.size()) {  // fully drained — reclaim memory
    this->tx_buf_.clear();
    this->tx_off_ = 0;
  }
}

void LokiDokiSatellite::process_event_(const std::string &type, const std::string &data_json,
                                       const uint8_t *payload, size_t payload_len) {
  if (type == "audio-chunk") {
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
    this->last_play_ms_ = millis();
    return;
  }
  if (type == "audio-stop") {
    // Mark end-of-reply; loop() releases the bus back to the mic once it drains.
    this->last_play_ms_ = millis();
    return;
  }
  if (type == "user-event") {
    std::string name, state, token;
    json::parse_json(data_json, [&](JsonObject root) -> bool {
      name = root["name"].as<std::string>();
      state = root["state"].as<std::string>();
      token = root["token"].as<std::string>();
      return true;
    });
    if (name == "face.state") {
      this->face_ = state;
      this->update_led_();
    } else if (name == "auth" && !token.empty()) {
      // The admin just Claimed us — persist the token for next boot.
      this->token_ = token;
      this->save_token_(token);
      ESP_LOGI(TAG, "claimed — token stored");
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

// ── feedback ────────────────────────────────────────────────────────────────

// LED legend (kept in sync with the app's "How to use" sheet):
//   amber, breathing → connecting / not reaching the Host
//   dim white, steady → connected & idle (waiting for "Hey Jarvis")
//   green, steady    → listening to you
//   blue, breathing  → thinking
//   cyan, steady     → speaking
void LokiDokiSatellite::update_led_() {
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
  if (!this->connected_ || this->playing_ || data.empty()) return;
  std::lock_guard<std::mutex> lk(this->mic_mtx_);
  // Cap the backlog small — heap is precious on this chip. ~0.25 s; older audio is
  // dropped if the uplink stalls.
  if (this->mic_buf_.size() > 8000) this->mic_buf_.clear();
  this->mic_buf_.insert(this->mic_buf_.end(), data.begin(), data.end());
}

}  // namespace lokidoki_satellite
}  // namespace esphome
