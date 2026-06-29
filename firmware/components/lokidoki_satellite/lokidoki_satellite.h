#pragma once

#include "esphome/core/component.h"
#include "esphome/core/preferences.h"
#include "esphome/components/microphone/microphone.h"
#include "esphome/components/speaker/speaker.h"
#include "esphome/components/light/light_state.h"
#include "esphome/components/text_sensor/text_sensor.h"

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
  // Called from the LVGL button event callback (a free C function), so it must be public.
  void send_button_press_(const std::string &page_id, int row, int col);
  void set_microphone(microphone::Microphone *mic) { this->mic_ = mic; }
  void set_speaker(speaker::Speaker *spk) { this->speaker_ = spk; }
  void set_status_light(light::LightState *light) { this->light_ = light; }
  // Optional: publishes the conversation state ("idle"/"listening"/"thinking"/
  // "talking") so a screen device (Tab5) can react in LVGL. Screenless pods leave
  // this unset and just use the status LED.
  void set_face_sensor(text_sensor::TextSensor *s) { this->face_sensor_ = s; }
  // Optional: mirrors the server-pushed screen mode ("normal"/"camera-test"/
  // "touch-test") so a screen device can switch LVGL pages from the admin Testing
  // tab. Screenless pods leave this unset.
  void set_mode_sensor(text_sensor::TextSensor *s) { this->mode_sensor_ = s; }
  // Optional: carries the companion's typed reply (shown on screen in text-only mode).
  void set_reply_sensor(text_sensor::TextSensor *s) { this->reply_sensor_ = s; }
  // Optional: screen backlight to dim on idle (driven by pushed config). Screenless
  // pods leave this unset.
  void set_backlight(light::LightState *bl) { this->backlight_ = bl; }

  void setup() override;
  void loop() override;
  void dump_config() override;
  // Need Wi-Fi up before we can open the socket.
  float get_setup_priority() const override { return setup_priority::AFTER_WIFI; }

  // Driven from the YAML button (GPIO39): hold-to-talk. Press starts a capture
  // (like a wake-word hit), release ends it. Works alongside server-side wake.
  void button_down();
  void button_up();

  // On-screen (touch) controls for screened pods. Mute suppresses TTS playback;
  // disabling the mic stops the uplink so the server-side wake word can't trigger.
  void set_muted(bool m) { this->muted_ = m; }
  bool is_muted() const { return this->muted_; }
  void toggle_muted() { this->muted_ = !this->muted_; }
  void set_mic_enabled(bool e) { this->mic_enabled_ = e; }
  bool is_mic_enabled() const { return this->mic_enabled_; }
  void toggle_mic_enabled() { this->mic_enabled_ = !this->mic_enabled_; }
  // Complete (Echo-style) privacy mute. Muted = no audio leaves the device at all:
  // on_mic_data_ drops everything (no wake word, no push-to-talk) AND we stop the mic
  // peripheral when idle so it isn't even capturing. Tap toggles; implemented in .cpp
  // so it can safely touch the shared I2S mic.
  bool is_mic_muted() const { return !this->mic_enabled_; }
  void toggle_mic_mute();
  // Push-to-talk (HOLD): open one listen turn immediately, skipping the wake word.
  // Only meaningful while live (the caller guards on !is_mic_muted()).
  void request_listen() {
    // Carry the CURRENT reply mode in the tap so the server uses it for THIS turn —
    // no dependency on a separate reply_mode event arriving (or surviving a reconnect) first.
    std::string m = this->voice_reply_ ? "voice" : "text";
    this->send_event_("detection", std::string("{\"name\":\"tap\",\"reply\":\"") + m + "\"}", nullptr, 0);
  }
  // Stop button: abort the in-flight turn on the server AND silence local playback
  // immediately — without this the already-buffered TTS keeps playing after Stop.
  void request_stop() {
    this->send_event_("user-event", "{\"name\":\"stop\"}", nullptr, 0);
    this->speaker_buffer_size_ = 0;     // drop buffered TTS
    this->speaker_buffer_index_ = 0;
    this->got_stop_ = true;             // let loop() end playback + hand the bus back to the mic
    // The server streams TTS ahead of playback, so seconds of audio-chunks for THIS reply
    // may still be queued in the socket. Discard everything that arrives until the NEXT
    // reply's audio-start — otherwise pump_rx_() keeps refilling the buffer and playback
    // never actually stops.
    this->discard_reply_audio_ = true;
  }
  bool voice_reply() const { return this->voice_reply_; }
  // Audio output mute (the right control). Mutes ALL speaker output (replies, chimes,
  // alarms) by holding the speaker at volume 0, AND tells the server not to synthesize
  // the reply (it's still typed on screen either way). is_audio_muted() == muted speaker.
  bool is_audio_muted() const { return this->muted_; }
  void toggle_audio_mute() {
    this->muted_ = !this->muted_;          // speaker volume 0 = all output silenced
    this->voice_reply_ = !this->muted_;    // audio on → speak the reply; off → type only
    this->send_reply_mode_();
    this->save_settings_();
  }

  // Stream Deck controller mode. Called from the YAML on_boot lambda to hand us
  // the blank LVGL page we dynamically populate with button cells.
  void set_stream_deck_page(void *page_obj) { this->sd_page_ = page_obj; }

 protected:
  // ── connection lifecycle ──
  bool connect_();
  void disconnect_(const char *why);
  void pump_rx_();          // drain the socket → rx_ buffer → whole events
  void pump_tx_audio_();    // queue buffered mic PCM up as audio-chunk(s)
  void flush_tx_();         // drain tx_buf_ to the socket (non-blocking)

  // ── Wyoming framing ──
  // Header line {"type","data_length","payload_length"}\n + JSON data + payload.
  void send_reply_mode_();  // tell the server whether to speak or type replies
  void send_event_(const char *type, const std::string &data_json, const uint8_t *payload,
                   size_t payload_len);
  void process_event_(const std::string &type, const std::string &data_json,
                      const uint8_t *payload, size_t payload_len);

  // ── identity ──
  void announce_or_auth_();          // hello (unclaimed) or auth (paired)
  void load_token_();
  void save_token_(const std::string &token);
  void load_settings_();   // restore per-device mic/audio mute from NVS on boot
  void save_settings_();   // persist mic/audio mute whenever the user toggles
  std::string hwid_() const;         // stable hardware id = Wi-Fi MAC

  // ── feedback (LED reflects connection + conversation state) ──
  void update_led_();   // recompute the LED target from connection + face state
  void tick_led_();     // animate pulsing states (connecting / thinking)
  void tick_dim_();     // idle screen dimming (backlight pods only)
  void apply_backlight_(float brightness);
  // ESPHome's microphone delivers raw little-endian PCM BYTES (not int16 samples).
  void on_mic_data_(const std::vector<uint8_t> &data);

  // ── Stream Deck ── (send_button_press_ is declared public above)
  void handle_stream_deck_config_(const std::string &data_json);
  void rebuild_stream_deck_ui_();

  std::string host_;
  uint16_t port_{10700};
  std::string model_{"atom-echo"};
  microphone::Microphone *mic_{nullptr};
  speaker::Speaker *speaker_{nullptr};
  light::LightState *light_{nullptr};
  text_sensor::TextSensor *face_sensor_{nullptr};
  std::string published_face_;  // last value pushed to face_sensor_ (de-dupe)
  text_sensor::TextSensor *mode_sensor_{nullptr};  // server-pushed screen mode
  text_sensor::TextSensor *reply_sensor_{nullptr}; // companion's typed reply (text mode)
  bool voice_reply_{true};                         // true = speak reply; false = type it
  std::string published_mode_;  // last value pushed to mode_sensor_ (de-dupe)

  // Idle screen dimming (configured live via the server's `config` event).
  light::LightState *backlight_{nullptr};
  bool dim_enabled_{false};
  uint8_t dim_percent_{30};
  uint32_t dim_after_ms_{60000};
  uint32_t last_active_ms_{0};
  bool dimmed_{false};

  int fd_{-1};                       // TCP socket (lwip)
  bool connected_{false};
  bool audio_started_{false};        // sent the single audio-start yet?
  uint32_t last_connect_attempt_{0};

  // Touch-control state (screened pods): mute TTS output, and stop streaming mic up.
  // Defaults on (screenless pods rely on it); screen devices that have a MIC button
  // disable it at boot via set_mic_enabled(false) so they don't wake on TV audio.
  bool muted_{false};
  bool mic_enabled_{true};

  // Half-duplex playback: while a reply plays we own the I2S bus with the speaker
  // and pause the mic; once the audio drains we hand the bus back to the mic.
  bool playing_{false};
  bool got_stop_{false};             // received audio-stop for the in-flight reply
  bool discard_reply_audio_{false};  // drop incoming TTS chunks (post-Stop) until next audio-start
  uint32_t last_play_ms_{0};

  std::vector<uint8_t> rx_;          // inbound frame bytes
  size_t rx_off_{0};                 // bytes already consumed from the front of rx_
  // Reply (TTS) playback buffer — a FIXED, pre-allocated 16 KB block driven EXACTLY
  // like Home Assistant's voice_assistant speaker path: memcpy chunks in, then
  // speaker_->play() + memmove out. A fixed buffer (never a growing std::vector) is
  // what keeps the heap stable on the classic ESP32 — the old growing buffer is what
  // fragmented the heap and threw std::bad_alloc mid-reply.
  uint8_t *speaker_buffer_{nullptr};
  size_t speaker_buffer_index_{0};   // write head (bytes currently buffered)
  size_t speaker_buffer_size_{0};    // bytes waiting to be played
  std::vector<uint8_t> tx_buf_;      // outbound queued frame bytes (drained non-blocking)
  size_t tx_off_{0};                 // bytes already sent from the front of tx_buf_
  std::vector<uint8_t> mic_buf_;     // outbound mic PCM, filled by the mic task
  std::mutex mic_mtx_;               // guards mic_buf_ (mic runs on its own task)

  std::string token_;                // device token (empty until claimed)
  ESPPreferenceObject token_pref_;
  ESPPreferenceObject settings_pref_;  // persisted mic/audio mute (per device, in NVS)

  // LED state
  std::string face_{"idle"};         // last conversation state from the Host
  float led_r_{1}, led_g_{1}, led_b_{1}, led_base_{0.1f};
  bool led_pulse_{false};
  uint32_t led_last_{0};

  // Stream Deck state. sd_page_ is the blank LVGL lv_obj_t* set on boot;
  // sd_pages_ holds the last config from the server; sd_btn_ctxs_ holds the
  // heap-allocated per-button callback data (freed + re-built on each config push).
  void *sd_page_{nullptr};
  bool sd_needs_rebuild_{false};   // defer LVGL work to loop() (main task = LVGL safe)

  struct SdButton {
    std::string id;
    int row{0}, col{0};
    std::string icon;
    std::string label;
    uint32_t bg_color{0x1e1e2e};
    uint32_t text_color{0xffffff};
  };
  struct SdPage {
    std::string id;
    std::string name;
    int grid_rows{3}, grid_cols{5};
    std::vector<SdButton> buttons;
  };
  std::vector<SdPage> sd_pages_;
  int sd_active_page_{0};
  std::vector<void *> sd_btn_ctxs_;  // heap-allocated SdBtnCtx*, freed on rebuild
};

}  // namespace lokidoki_satellite
}  // namespace esphome
