#include "hw_jpeg.h"
#include "esphome/core/log.h"

#include "driver/jpeg_decode.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "lwip/sockets.h"
#include "lwip/inet.h"
#include "esp_mac.h"
#include <cstring>
#include <cerrno>
#include <vector>

namespace esphome {
namespace hw_jpeg {

static const char *const TAG = "hw_jpeg";

// Generous input cap — a 720p JPEG at our quality is ~40-80 KB; allow headroom.
static constexpr size_t JPEG_INPUT_CAP = 256 * 1024;

void HwJpeg::setup() {
  jpeg_decode_engine_cfg_t eng_cfg = {};
  eng_cfg.intr_priority = 0;
  eng_cfg.timeout_ms = 200;
  jpeg_decoder_handle_t dec = nullptr;
  esp_err_t err = jpeg_new_decoder_engine(&eng_cfg, &dec);
  if (err != ESP_OK) {
    ESP_LOGE(TAG, "jpeg_new_decoder_engine failed: 0x%x", err);
    this->mark_failed();
    return;
  }
  this->decoder_ = dec;

  // Output: two DMA-capable RGB565 buffers (2 bytes/px) for tear-free double buffering.
  jpeg_decode_memory_alloc_cfg_t rx_cfg = {};
  rx_cfg.buffer_direction = JPEG_DEC_ALLOC_OUTPUT_BUFFER;
  const size_t want = static_cast<size_t>(this->width_) * this->height_ * 2;
  for (int i = 0; i < 2; i++) {
    size_t got = 0;
    this->buf_[i] = static_cast<uint8_t *>(jpeg_alloc_decoder_mem(want, &rx_cfg, &got));
    if (this->buf_[i] == nullptr) {
      ESP_LOGE(TAG, "output buffer %d alloc failed (%u bytes)", i, (unsigned) want);
      this->mark_failed();
      return;
    }
    this->out_cap_ = got;
    memset(this->buf_[i], 0, got);
  }

  // Native-size decode target: the JPEG decoder writes here at the frame's real size
  // (e.g. 640x360), then we upscale into buf_[] at the panel's native 1280x720 so the
  // image fills the screen with a plain 1:1 blit (no LVGL scale → no rotation artifacts).
  {
    size_t got = 0;
    this->decode_tmp_ = static_cast<uint8_t *>(jpeg_alloc_decoder_mem(want, &rx_cfg, &got));
    if (this->decode_tmp_ == nullptr) {
      ESP_LOGE(TAG, "decode_tmp alloc failed");
      this->mark_failed();
      return;
    }
    this->decode_tmp_cap_ = got;
  }

  // Two ping-pong input buffers: the receive task reassembles into one and hands its
  // INDEX (not a copy) to the decode task, then switches to the other. No memcpy → no
  // cache-vs-DMA coherency hazard, and the decoder reads incrementally-written PSRAM.
  jpeg_decode_memory_alloc_cfg_t tx_cfg = {};
  tx_cfg.buffer_direction = JPEG_DEC_ALLOC_INPUT_BUFFER;
  for (int i = 0; i < 2; i++) {
    size_t jgot = 0;
    this->jpeg_buf_[i] = static_cast<uint8_t *>(jpeg_alloc_decoder_mem(JPEG_INPUT_CAP, &tx_cfg, &jgot));
    if (this->jpeg_buf_[i] == nullptr) {
      ESP_LOGE(TAG, "input buffer %d alloc failed", i);
      this->mark_failed();
      return;
    }
    this->jpeg_cap_ = jgot;
  }
  this->decode_sem_ = xSemaphoreCreateBinary();
  esp_efuse_mac_get_default(this->mac_);  // for the stats hello

  // Split across cores so decode can't starve the drain: the receive task gets core 1
  // to itself (higher priority — dropping a frame is recoverable, missing a fragment is
  // not), while the heavier decode+upscale shares core 0 with the ESPHome/LVGL main loop.
  xTaskCreatePinnedToCore(&HwJpeg::decode_trampoline, "hwjpeg_dec", 8192, this, 4, nullptr, 0);
  xTaskCreatePinnedToCore(&HwJpeg::task_trampoline, "hwjpeg_rx", 8192, this, 6, nullptr, 1);
  ESP_LOGI(TAG, "ready %dx%d udp=%s:%d", this->width_, this->height_, this->host_.c_str(),
           this->udp_port_);
}

void HwJpeg::task_trampoline(void *arg) { static_cast<HwJpeg *>(arg)->task_loop(); }

void HwJpeg::task_loop() {
  for (;;) {
    if (this->host_.empty()) {
      vTaskDelay(pdMS_TO_TICKS(500));
      continue;
    }
    this->udp_loop_();                  // receive + reassemble UDP frames until the socket dies
    vTaskDelay(pdMS_TO_TICKS(500));     // backoff, then re-open the socket
  }
}

void HwJpeg::on_http_data(const uint8_t *, size_t) {}  // unused (UDP path); kept for ABI

// Datagram wire format: [frame_id u16 LE][frag_idx u8][frag_cnt u8][payload ≤1400B].
// We send a 1 s "hello" so the server knows where to stream; reassemble fragments by
// frame_id and decode once a frame is complete. A lost fragment just drops that frame.
void HwJpeg::udp_loop_() {
  constexpr size_t FRAG = 1400;

  int sock = ::socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  if (sock < 0)
    return;

  // 1 s receive timeout so we periodically re-send the hello even if no frames arrive.
  timeval tv = {};
  tv.tv_sec = 1;
  setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
  // Big socket RX buffer so a burst of a frame's datagrams isn't dropped before the
  // receive task reads them (it now does nothing but drain, so this is rarely full).
  int rcvbuf = 256 * 1024;
  setsockopt(sock, SOL_SOCKET, SO_RCVBUF, &rcvbuf, sizeof(rcvbuf));

  sockaddr_in srv = {};
  srv.sin_family = AF_INET;
  srv.sin_port = htons(static_cast<uint16_t>(this->udp_port_));
  srv.sin_addr.s_addr = inet_addr(this->host_.c_str());

  uint32_t last_hello = 0;
  int cur_frame = -1;
  int frags_needed = 0, frags_got = 0;
  size_t total_len = 0;
  std::vector<uint8_t> got_map(256, 0);
  std::vector<uint8_t> pkt(FRAG + 64);

  for (;;) {
    uint32_t now = millis();
    if (now - last_hello >= 1000) {
      // Hello + stats: "LDC2" + mac[6] + received(u32 LE) + decoded(u32 LE) + last_bytes(u32 LE).
      // The server registers us by source addr AND maps these counters to our device by MAC.
      uint8_t hello[22] = {'L', 'D', 'C', '2'};
      memcpy(hello + 4, this->mac_, 6);
      const uint32_t r = this->received_frames_.load();
      const uint32_t d = this->frames_.load();
      const uint32_t lb = this->last_bytes_.load();
      memcpy(hello + 10, &r, 4);
      memcpy(hello + 14, &d, 4);
      memcpy(hello + 18, &lb, 4);
      sendto(sock, hello, sizeof(hello), 0, reinterpret_cast<sockaddr *>(&srv), sizeof(srv));
      last_hello = now;
    }

    int n = recvfrom(sock, pkt.data(), pkt.size(), 0, nullptr, nullptr);
    if (n < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK)
        continue;  // timeout — loop to re-send hello
      break;       // real socket error — rebuild
    }
    if (n < 4)
      continue;

    const uint16_t fid = static_cast<uint16_t>(pkt[0] | (pkt[1] << 8));
    const uint8_t idx = pkt[2];
    const uint8_t cnt = pkt[3];
    const int plen = n - 4;
    if (cnt == 0)
      continue;

    if (static_cast<int>(fid) != cur_frame) {
      cur_frame = fid;
      frags_needed = cnt;
      frags_got = 0;
      total_len = 0;
      std::fill(got_map.begin(), got_map.end(), 0);
    }

    const size_t off = static_cast<size_t>(idx) * FRAG;
    if (off + plen > this->jpeg_cap_)
      continue;  // malformed offset — ignore
    if (!got_map[idx]) {
      memcpy(this->jpeg_buf_[this->recv_buf_idx_] + off, pkt.data() + 4, plen);
      got_map[idx] = 1;
      frags_got++;
      if (off + plen > total_len)
        total_len = off + plen;
    }

    if (frags_got >= frags_needed && total_len > 0) {
      this->last_bytes_.store(static_cast<uint32_t>(total_len));
      this->received_frames_.fetch_add(1);  // a whole JPEG arrived, independent of decode
      // Hand THIS buffer's index to the decode task if it's free, then reassemble the
      // next frame into the OTHER buffer (ping-pong). Otherwise drop this whole frame.
      // We never block the drain and never split a frame.
      if (!this->decoding_.load()) {
        this->pending_idx_ = this->recv_buf_idx_;
        this->decode_len_ = total_len;
        this->decoding_.store(true);
        this->recv_buf_idx_ ^= 1;
        xSemaphoreGive(static_cast<SemaphoreHandle_t>(this->decode_sem_));
      }
      cur_frame = -1;  // done — ignore any stray trailing fragments of this frame
    }
  }

  close(sock);
}

void HwJpeg::decode_trampoline(void *arg) { static_cast<HwJpeg *>(arg)->decode_task_(); }

void HwJpeg::decode_task_() {
  for (;;) {
    if (xSemaphoreTake(static_cast<SemaphoreHandle_t>(this->decode_sem_), portMAX_DELAY) != pdTRUE)
      continue;
    const size_t len = this->decode_len_;
    const int back = 1 - this->front_.load();
    if (this->decode_into_(back, len)) {
      this->front_.store(back);
      this->new_frame_.store(true);
      this->frames_.fetch_add(1);
    }
    this->decoding_.store(false);  // free to accept the next frame from the receive task
  }
}

// Nearest-neighbour upscale of an RGB565 image (sw×sh) to (dw×dh). Cheap gather copy
// with a cached x-map; runs on the decode task so the main loop stays free.
void HwJpeg::upscale_(const uint8_t *src, int sw, int sh, uint8_t *dst, int dw, int dh) {
  const uint16_t *s = reinterpret_cast<const uint16_t *>(src);
  uint16_t *d = reinterpret_cast<uint16_t *>(dst);
  static int xmap[1280];
  static int cached_sw = 0, cached_dw = 0;
  if (sw != cached_sw || dw != cached_dw) {
    for (int x = 0; x < dw && x < 1280; x++)
      xmap[x] = (x * sw) / dw;
    cached_sw = sw;
    cached_dw = dw;
  }
  for (int y = 0; y < dh; y++) {
    const uint16_t *srow = s + static_cast<size_t>((y * sh) / dh) * sw;
    uint16_t *drow = d + static_cast<size_t>(y) * dw;
    for (int x = 0; x < dw; x++)
      drow[x] = srow[xmap[x]];
  }
}

bool HwJpeg::decode_into_(int slot, size_t jpeg_len) {
  uint8_t *src = this->jpeg_buf_[this->pending_idx_];  // the buffer handed off by the receive task
  jpeg_decode_picture_info_t info = {};
  if (jpeg_decoder_get_info(src, jpeg_len, &info) != ESP_OK)
    return false;
  // Never decode a frame bigger than the native decode buffer we allocated.
  if (static_cast<size_t>(info.width) * info.height * 2 > this->decode_tmp_cap_) {
    ESP_LOGW(TAG, "frame %dx%d exceeds buffer, skipping", info.width, info.height);
    return false;
  }

  jpeg_decode_cfg_t dcfg = {};
  dcfg.output_format = JPEG_DECODE_OUT_FORMAT_RGB565;
  // BGR matches LVGL's RGB565 byte order on this panel; flip to RGB on-device if colors swap.
  dcfg.rgb_order = JPEG_DEC_RGB_ELEMENT_ORDER_BGR;
  dcfg.conv_std = JPEG_YUV_RGB_CONV_STD_BT601;

  // If the frame already matches the panel, decode straight into the display buffer —
  // no upscale, no extra PSRAM pass (this is the fast path: scale on the server). Only
  // a smaller frame needs the (slower) CPU upscale to fill the screen.
  const bool fullsize = (info.width == this->width_ && info.height == this->height_);
  uint8_t *dec_target = fullsize ? this->buf_[slot] : this->decode_tmp_;
  const size_t dec_cap = fullsize ? this->out_cap_ : this->decode_tmp_cap_;

  uint32_t out_size = 0;
  esp_err_t err = jpeg_decoder_process(static_cast<jpeg_decoder_handle_t>(this->decoder_), &dcfg,
                                       src, jpeg_len, dec_target, dec_cap, &out_size);
  if (err != ESP_OK) {
    ESP_LOGW(TAG, "decode failed: 0x%x", err);
    return false;
  }
  if (out_size == 0)
    return false;

  if (!fullsize) {
    // Upscale the smaller frame to fill the panel (fallback path).
    this->upscale_(this->decode_tmp_, info.width, info.height, this->buf_[slot], this->width_,
                   this->height_);
  }
  this->frame_w_.store(this->width_);
  this->frame_h_.store(this->height_);
  return true;
}

}  // namespace hw_jpeg
}  // namespace esphome
