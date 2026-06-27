#pragma once

#include "esphome/core/component.h"
#include "esphome/core/preferences.h"
#include "esphome/components/microphone/microphone.h"
#include "esphome/components/speaker/speaker.h"
#include "esphome/components/light/light_state.h"

#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

namespace esphome {
namespace lokidoki_satellite {

// One persistent TCP connection to the Loki Doki Wyoming gateway. Streams 16 kHz
// mono int16 mic PCM up (continuously — wake word runs server-side), plays TTS
// PCM down to the speaker, and drives the status LED from the server's
// face.state. On first boot with no token it announces a `hello` (so the admin
// can Claim it) and persists the pushed `auth` token to NVS for next time.
class LokiDokiSatellite : public Component {
 public:
  void set_host(const std::string &host) { this->host_ = host; }
  void set_port(uint16_t port) { this->port_ = port; }
  void set_model(const std::string &model) { this->model_ = model; }
  void set_microphone(microphone::Microphone *mic) { this->mic_ = mic; }
  void set_speaker(speaker::Speaker *spk) { this->speaker_ = spk; }
  void set_status_light(light::LightState *light) { this->light_ = light; }

  void setup() override;
  void loop() override;
  void dump_config() override;
  // Need Wi-Fi up before we can open the socket.
  float get_setup_priority() const override { return setup_priority::AFTER_WIFI; }

  // Driven from the YAML button (GPIO39): hold-to-talk. Press starts a capture
  // (like a wake-word hit), release ends it. Works alongside server-side wake.
  void button_down();
  void button_up();

 protected:
  // ── connection lifecycle ──
  bool connect_();
  void disconnect_(const char *why);
  void pump_rx_();          // drain the socket → rx_ buffer → whole events
  void pump_tx_audio_();    // flush buffered mic PCM up as audio-chunk(s)

  // ── Wyoming framing ──
  // Header line {"type","data_length","payload_length"}\n + JSON data + payload.
  void send_event_(const char *type, const std::string &data_json, const uint8_t *payload,
                   size_t payload_len);
  void process_event_(const std::string &type, const std::string &data_json,
                      const uint8_t *payload, size_t payload_len);

  // ── identity ──
  void announce_or_auth_();          // hello (unclaimed) or auth (paired)
  void load_token_();
  void save_token_(const std::string &token);
  std::string hwid_() const;         // stable hardware id = Wi-Fi MAC

  // ── feedback (LED reflects connection + conversation state) ──
  void update_led_();   // recompute the LED target from connection + face state
  void tick_led_();     // animate pulsing states (connecting / thinking)
  // ESPHome's microphone delivers raw little-endian PCM BYTES (not int16 samples).
  void on_mic_data_(const std::vector<uint8_t> &data);

  std::string host_;
  uint16_t port_{10700};
  std::string model_{"atom-echo"};
  microphone::Microphone *mic_{nullptr};
  speaker::Speaker *speaker_{nullptr};
  light::LightState *light_{nullptr};

  int fd_{-1};                       // TCP socket (lwip)
  bool connected_{false};
  bool audio_started_{false};        // sent the single audio-start yet?
  uint32_t last_connect_attempt_{0};

  std::vector<uint8_t> rx_;          // partial inbound frame bytes
  std::vector<uint8_t> mic_buf_;     // outbound mic PCM, filled by the mic task
  std::mutex mic_mtx_;               // guards mic_buf_ (mic runs on its own task)

  std::string token_;                // device token (empty until claimed)
  ESPPreferenceObject token_pref_;

  // LED state
  std::string face_{"idle"};         // last conversation state from the Host
  float led_r_{1}, led_g_{1}, led_b_{1}, led_base_{0.1f};
  bool led_pulse_{false};
  uint32_t led_last_{0};
};

}  // namespace lokidoki_satellite
}  // namespace esphome
