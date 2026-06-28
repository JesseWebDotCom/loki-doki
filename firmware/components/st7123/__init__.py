import esphome.codegen as cg

# ST7123 integrated display+touch controller (M5Stack Tab5 V2 / new revision). The
# touch engine answers on I²C at 0x55 (NOT the GT911's 0x5D/0x14). Vendored from the
# community Tab5-V2 ESPHome component; protocol matches M5GFX's Touch_ST7123 driver.
CODEOWNERS = ["@miniskipper"]
DEPENDENCIES = ["i2c"]

st7123_ns = cg.esphome_ns.namespace("st7123")
