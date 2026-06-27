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

void LokiDokiSatellite::setup() {
  this->load_token_();

  // The mic runs on its own I2S task; buffer its PCM and flush from loop().
  if (this->mic_ != nullptr) {
    this->mic_->add_data_callback([this](const std::vector<uint8_t> &data) { this->on_mic_data_(data); });
    this->mic_->start();
  }
  if (this->speaker_ != nullptr) {
    this->speaker_->start();
  }
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
  this->pump_tx_audio_();
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

  // Non-blocking + TCP_NODELAY so reads never stall the loop and audio is snappy.
  int flags = ::fcntl(fd, F_GETFL, 0);
  ::fcntl(fd, F_SETFL, flags | O_NONBLOCK);
  int one = 1;
  ::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));

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
  this->update_led_();  // back to the amber "connecting" pulse
  ESP_LOGW(TAG, "disconnected (%s)", why);
}

void LokiDokiSatellite::pump_rx_() {
  uint8_t chunk[1024];
  for (;;) {
    ssize_t n = ::recv(this->fd_, chunk, sizeof(chunk), 0);
    if (n > 0) {
      this->rx_.insert(this->rx_.end(), chunk, chunk + n);
      if (n < (ssize_t) sizeof(chunk)) break;  // drained the socket for now
      continue;
    }
    if (n == 0) {  // peer closed
      this->disconnect_("peer closed");
      return;
    }
    if (errno == EWOULDBLOCK || errno == EAGAIN) break;  // nothing more to read
    this->disconnect_("recv error");
    return;
  }

  // Parse as many whole Wyoming frames as we have:
  //   {"type":..,"data_length":N,"payload_length":M}\n  <N data><M payload>
  for (;;) {
    auto nl = std::find(this->rx_.begin(), this->rx_.end(), '\n');
    if (nl == this->rx_.end()) return;  // no full header line yet
    size_t header_len = nl - this->rx_.begin();
    std::string header(reinterpret_cast<const char *>(this->rx_.data()), header_len);

    std::string type;
    size_t data_len = 0, payload_len = 0;
    json::parse_json(header, [&](JsonObject root) -> bool {
      // Missing keys decode to ""/0 in ArduinoJson v7, so no presence checks needed.
      type = root["type"].as<std::string>();
      data_len = root["data_length"].as<size_t>();
      payload_len = root["payload_length"].as<size_t>();
      return true;
    });

    size_t need = header_len + 1 + data_len + payload_len;
    if (this->rx_.size() < need) return;  // wait for the rest of the body

    size_t off = header_len + 1;
    std::string data_json;
    if (data_len > 0) {
      data_json.assign(reinterpret_cast<const char *>(this->rx_.data() + off), data_len);
      off += data_len;
    }
    const uint8_t *payload = nullptr;
    if (payload_len > 0) {
      payload = this->rx_.data() + off;
      off += payload_len;
    }

    this->process_event_(type, data_json, payload, payload_len);
    this->rx_.erase(this->rx_.begin(), this->rx_.begin() + need);
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

  // One contiguous buffer so the frame can't be split mid-header on the wire.
  std::vector<uint8_t> frame;
  frame.reserve(header.size() + data_json.size() + payload_len);
  frame.insert(frame.end(), header.begin(), header.end());
  frame.insert(frame.end(), data_json.begin(), data_json.end());
  if (payload_len > 0) frame.insert(frame.end(), payload, payload + payload_len);

  size_t sent = 0;
  while (sent < frame.size()) {
    ssize_t n = ::send(this->fd_, frame.data() + sent, frame.size() - sent, 0);
    if (n > 0) {
      sent += n;
      continue;
    }
    if (n < 0 && (errno == EWOULDBLOCK || errno == EAGAIN)) {
      // Socket buffer full — drop the rest of THIS frame (it's audio; a gap is
      // better than blocking the loop). Control frames are tiny and rarely hit this.
      break;
    }
    this->disconnect_("send error");
    return;
  }
}

void LokiDokiSatellite::process_event_(const std::string &type, const std::string &data_json,
                                       const uint8_t *payload, size_t payload_len) {
  if (type == "audio-chunk") {
    if (payload != nullptr && payload_len > 0 && this->speaker_ != nullptr) {
      this->speaker_->play(payload, payload_len);
    }
    return;
  }
  if (type == "audio-start") {
    if (this->speaker_ != nullptr) this->speaker_->start();
    return;
  }
  if (type == "audio-stop") {
    return;  // let the speaker drain on its own
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
    r = 1.0f; g = 0.55f; b = 0.0f; base = 0.5f; pulse = true;     // amber
  } else if (this->face_ == "listening") {
    r = 0.0f; g = 1.0f; b = 0.0f; base = 0.75f;                   // green
  } else if (this->face_ == "thinking") {
    r = 0.1f; g = 0.3f; b = 1.0f; base = 0.6f; pulse = true;      // blue
  } else if (this->face_ == "talking") {
    r = 0.0f; g = 1.0f; b = 1.0f; base = 0.7f;                    // cyan
  } else {                                 // idle/connected, waiting for wake
    r = 1.0f; g = 1.0f; b = 1.0f; base = 0.10f;                   // dim white
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
  if (!this->connected_ || data.empty()) return;
  std::lock_guard<std::mutex> lk(this->mic_mtx_);
  // Cap the backlog so a stalled uplink can't grow this without bound (~1 s of
  // 16 kHz 16-bit mono = 32000 bytes).
  if (this->mic_buf_.size() > 32000) this->mic_buf_.clear();
  this->mic_buf_.insert(this->mic_buf_.end(), data.begin(), data.end());
}

}  // namespace lokidoki_satellite
}  // namespace esphome
