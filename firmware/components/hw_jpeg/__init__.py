# Hardware-accelerated JPEG display source for the ESP32-P4 (Tab5).
#
# ESPHome's stock `online_image` decodes JPEG in software — ~5s/frame at 720p, the
# reason the server-rendered display is a slideshow. The P4 has a HARDWARE JPEG
# decoder (esp_driver_jpeg); this component pulls frames over HTTP and decodes them
# in hardware on a background task into a double-buffered RGB565 frame, which a tiny
# LVGL lambda then swaps into a canvas. No LVGL calls happen in here (LVGL isn't
# thread-safe) — the component only produces frames; the YAML updates the screen.

import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.const import CONF_ID

CONF_URL = "url"
CONF_HOST = "host"
CONF_UDP_PORT = "udp_port"
CONF_WIDTH = "width"
CONF_HEIGHT = "height"
CONF_POLL_INTERVAL = "poll_interval"

hw_jpeg_ns = cg.esphome_ns.namespace("hw_jpeg")
HwJpeg = hw_jpeg_ns.class_("HwJpeg", cg.Component)

CONFIG_SCHEMA = cv.Schema(
    {
        cv.GenerateID(): cv.declare_id(HwJpeg),
        cv.Optional(CONF_URL, default=""): cv.string,
        # Frames now arrive over UDP (TCP inbound stalls on the esp-hosted SDIO bridge,
        # espressif/esp-hosted-mcu#184). host = the server IP; udp_port = its stream port.
        cv.Optional(CONF_HOST, default=""): cv.string,
        cv.Optional(CONF_UDP_PORT, default=10701): cv.port,
        cv.Optional(CONF_WIDTH, default=1280): cv.positive_int,
        cv.Optional(CONF_HEIGHT, default=720): cv.positive_int,
        cv.Optional(CONF_POLL_INTERVAL, default=60): cv.positive_int,
    }
).extend(cv.COMPONENT_SCHEMA)


async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)
    cg.add(var.set_url(config[CONF_URL]))
    cg.add(var.set_host(config[CONF_HOST]))
    cg.add(var.set_udp_port(config[CONF_UDP_PORT]))
    cg.add(var.set_size(config[CONF_WIDTH], config[CONF_HEIGHT]))
    cg.add(var.set_poll_interval(config[CONF_POLL_INTERVAL]))
