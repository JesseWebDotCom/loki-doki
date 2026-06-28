#pragma once

#include "esphome/core/component.h"
#include <atomic>
#include <string>

namespace esphome {
namespace hw_jpeg {

// Produces decoded RGB565 frames from an HTTP JPEG endpoint using the ESP32-P4
// hardware JPEG decoder. Fetch + decode run on a background task; the latest
// complete frame is exposed via front_buffer() for the LVGL thread to display.
class HwJpeg : public Component {
 public:
  void set_url(const std::string &u) { this->url_ = u; }
  void set_host(const std::string &h) { this->host_ = h; }
  void set_udp_port(int p) { this->udp_port_ = p; }
  void set_size(int w, int h) {
    this->width_ = w;
    this->height_ = h;
  }
  void set_poll_interval(uint32_t ms) { this->poll_ms_ = ms; }

  void setup() override;
  void loop() override {}
  float get_setup_priority() const override { return setup_priority::AFTER_WIFI; }

  // ── consumed from the LVGL/main thread ──
  bool has_new_frame() const { return this->new_frame_.load(); }
  void clear_new_frame() { this->new_frame_.store(false); }
  uint8_t *front_buffer() { return this->buf_[this->front_.load()]; }
  int width() const { return this->width_; }
  int height() const { return this->height_; }
  // Actual pixel dimensions of the latest decoded frame (the camera's aspect may
  // differ from the allocated buffer; the LVGL image is bound to these).
  int frame_w() const { return this->frame_w_.load(); }
  int frame_h() const { return this->frame_h_.load(); }
  // Diagnostics: frames the RECEIVE task fully reassembled vs frames the DECODE task
  // actually decoded. received≈decoded → decode-limited (good, architecture correct);
  // received≫decoded → still drop/starve-limited somewhere.
  uint32_t frames() const { return this->frames_.load(); }
  uint32_t received() const { return this->received_frames_.load(); }
  uint32_t last_bytes() const { return this->last_bytes_.load(); }

 protected:
 public:
  // Called by the HTTP event handler as response bytes arrive (one frame per request).
  void on_http_data(const uint8_t *data, size_t len);

 protected:
  static void task_trampoline(void *arg);
  void task_loop();
  void udp_loop_();      // UDP receive + reassemble ONLY (never blocks on decode)
  static void decode_trampoline(void *arg);
  void decode_task_();   // decodes handed-off frames on its own task, in parallel
  bool decode_into_(int slot, size_t jpeg_len);

  std::string url_;
  std::string host_;     // server IP to stream frames from (UDP)
  int udp_port_{10701};
  uint8_t mac_[6]{};     // this device's MAC, sent in the hello so the server can map stats to it
  int width_{1280};
  int height_{720};
  uint32_t poll_ms_{60};

  void *decoder_{nullptr};             // jpeg_decoder_handle_t (opaque here)
  uint8_t *jpeg_buf_[2]{nullptr, nullptr};  // ping-pong reassembly buffers (no memcpy hand-off)
  size_t jpeg_cap_{0};
  int recv_buf_idx_{0};                 // buffer the receive task reassembles into
  int pending_idx_{0};                  // buffer handed to the decode task
  uint8_t *decode_tmp_{nullptr};       // native-size decode target (before upscale)
  size_t decode_tmp_cap_{0};
  // Hand-off from the receive task to the decode task (by buffer index, not a copy —
  // a memcpy here left the JPEG in CPU cache while the decoder DMA read stale PSRAM).
  volatile size_t decode_len_{0};
  void *decode_sem_{nullptr};          // SemaphoreHandle_t (binary) — frame ready to decode
  std::atomic<bool> decoding_{false};
  uint8_t *buf_[2]{nullptr, nullptr};  // double-buffered RGB565 output (panel-native size)
  size_t out_cap_{0};
  void upscale_(const uint8_t *src, int sw, int sh, uint8_t *dst, int dw, int dh);
  size_t recv_len_{0};                 // bytes received for the in-flight frame
  std::atomic<int> front_{0};          // index of the latest complete frame
  std::atomic<bool> new_frame_{false};
  std::atomic<uint32_t> frames_{0};    // total frames decoded (diagnostic)
  std::atomic<uint32_t> received_frames_{0}; // total frames fully reassembled by receive task
  std::atomic<uint32_t> last_bytes_{0};// bytes of the last frame (diagnostic)
  std::atomic<int> frame_w_{0};        // decoded width of the latest frame
  std::atomic<int> frame_h_{0};        // decoded height of the latest frame
};

}  // namespace hw_jpeg
}  // namespace esphome
