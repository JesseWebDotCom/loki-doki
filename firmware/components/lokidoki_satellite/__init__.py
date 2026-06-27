"""ESPHome external component: Loki Doki voice satellite (Wyoming over TCP).

Streams 16 kHz mic PCM to the Loki Doki gateway and plays back the companion's
TTS, driving the status LED from the server's face.state. Handles the device
identity handshake (hello → claim → auth token persisted in NVS).
"""

import esphome.codegen as cg
import esphome.config_validation as cv
from esphome.components import microphone, speaker, light
from esphome.const import CONF_ID, CONF_PORT, CONF_MODEL

CODEOWNERS = ["@lokidoki"]
DEPENDENCIES = ["network"]
# socket: TCP client to the gateway. json: parse incoming Wyoming headers/data.
AUTO_LOAD = ["socket", "json"]

lokidoki_ns = cg.esphome_ns.namespace("lokidoki_satellite")
LokiDokiSatellite = lokidoki_ns.class_("LokiDokiSatellite", cg.Component)

CONF_HOST = "host"
CONF_MICROPHONE = "microphone"
CONF_SPEAKER = "speaker"
CONF_STATUS_LIGHT = "status_light"

CONFIG_SCHEMA = cv.Schema(
    {
        cv.GenerateID(): cv.declare_id(LokiDokiSatellite),
        cv.Required(CONF_HOST): cv.string,
        cv.Optional(CONF_PORT, default=10700): cv.port,
        cv.Optional(CONF_MODEL, default="atom-echo"): cv.string,
        cv.Required(CONF_MICROPHONE): cv.use_id(microphone.Microphone),
        cv.Required(CONF_SPEAKER): cv.use_id(speaker.Speaker),
        cv.Optional(CONF_STATUS_LIGHT): cv.use_id(light.LightState),
    }
).extend(cv.COMPONENT_SCHEMA)


async def to_code(config):
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)

    cg.add(var.set_host(config[CONF_HOST]))
    cg.add(var.set_port(config[CONF_PORT]))
    cg.add(var.set_model(config[CONF_MODEL]))

    mic = await cg.get_variable(config[CONF_MICROPHONE])
    cg.add(var.set_microphone(mic))
    spk = await cg.get_variable(config[CONF_SPEAKER])
    cg.add(var.set_speaker(spk))

    if CONF_STATUS_LIGHT in config:
        led = await cg.get_variable(config[CONF_STATUS_LIGHT])
        cg.add(var.set_status_light(led))
