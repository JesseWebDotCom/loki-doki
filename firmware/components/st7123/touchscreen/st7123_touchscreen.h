#pragma once

#include "esphome/components/i2c/i2c.h"
#include "esphome/components/touchscreen/touchscreen.h"
#include "esphome/core/component.h"
#include "esphome/core/hal.h"

namespace esphome {
namespace st7123 {

class ST7123ButtonListener {
 public:
  virtual void update_button(uint8_t index, bool state) = 0;
};

class ST7123Touchscreen : public touchscreen::Touchscreen, public i2c::I2CDevice {
 public:
  /// @brief Initialize the ST7123 touchscreen.
  ///
  /// reset_pin_ here is the ST7123 touch ENABLE line (BSP_TOUCH_EN, IO-expander
  /// 0x43 P5). It needs a clean disable→enable (low→high) edge to boot the touch
  /// firmware and start scanning; without it the chip ACKs I²C and returns config
  /// registers but never reports coordinates. Setup runs the enable pulse then
  /// schedules the rest 50 ms later via set_timeout() to let the engine come up.
  void setup() override;
  void dump_config() override;
  bool can_proceed() override { return this->setup_done_; }

  void set_interrupt_pin(InternalGPIOPin *pin) { this->interrupt_pin_ = pin; }
  void set_reset_pin(GPIOPin *pin) { this->reset_pin_ = pin; }
  void register_button_listener(ST7123ButtonListener *listener) { this->button_listeners_.push_back(listener); }

 protected:
  void update_touches() override;

  /// @brief Perform the internal setup routine for the ST7123 touchscreen.
  void setup_internal_();
  /// @brief Read the calibration data (maximum X and Y values) if not already set.
  void setup_lazy_();
  /// @brief True if the touchscreen setup has completed successfully.
  bool setup_done_{false};

  InternalGPIOPin *interrupt_pin_{nullptr};
  GPIOPin *reset_pin_{nullptr};
  std::vector<ST7123ButtonListener *> button_listeners_;
  uint8_t button_state_{0xFF};  // last button state. Initial FF guarantees first update.
};

}  // namespace st7123
}  // namespace esphome
