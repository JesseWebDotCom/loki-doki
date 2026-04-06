import platform
import os


def detect_platform() -> str:
    """Detect the runtime platform: 'pi5', 'pi', 'mac', or 'linux'.

    Checks /proc/cpuinfo for Raspberry Pi 5 (BCM2712) vs earlier Pi models,
    then falls back to uname-based detection for Mac/Linux.
    """
    system = platform.system().lower()

    if system == "linux":
        try:
            with open("/proc/cpuinfo", "r") as f:
                cpuinfo = f.read().lower()
            if "bcm2712" in cpuinfo or "raspberry pi 5" in cpuinfo:
                return "pi5"
            if "raspberry pi" in cpuinfo or "bcm2" in cpuinfo:
                return "pi"
        except OSError:
            pass
        # Check device-tree model (more reliable on newer kernels)
        try:
            with open("/proc/device-tree/model", "r") as f:
                model = f.read().lower()
            if "raspberry pi 5" in model:
                return "pi5"
            if "raspberry pi" in model:
                return "pi"
        except OSError:
            pass
        return "linux"

    if system == "darwin":
        return "mac"

    return system


# Platform-specific model presets
PLATFORM_MODELS = {
    "pi5": {
        "fast_model": "gemma4:e2b",
        "thinking_model": "gemma4",
        "fast_keep_alive": -1,
        "thinking_keep_alive": "5m",
    },
    "pi": {
        "fast_model": "gemma4:e2b",
        "thinking_model": "gemma4:e2b",  # Pi 4 can't handle 9B
        "fast_keep_alive": -1,
        "thinking_keep_alive": "5m",
    },
    "mac": {
        "fast_model": "gemma4:e2b",
        "thinking_model": "gemma4",
        "fast_keep_alive": -1,
        "thinking_keep_alive": "5m",
    },
    "linux": {
        "fast_model": "gemma4:e2b",
        "thinking_model": "gemma4",
        "fast_keep_alive": -1,
        "thinking_keep_alive": "5m",
    },
}


def get_model_preset(plat: str | None = None) -> dict:
    """Return model preset dict for the given or detected platform."""
    if plat is None:
        plat = detect_platform()
    return PLATFORM_MODELS.get(plat, PLATFORM_MODELS["linux"])
