| Role | Pi Hailo (be-more-hailo) | MacBook Pro M4 (Recommended) | Notes |
|------|--------------------------|------------------------------|-------|
| **LLM** | | | |
| Fast LLM | qwen2.5-instruct:1.5b<br>via hailo-ollama, port 8000 | qwen2.5:7b-instruct-q4_K_M<br>via Ollama, non-thinking mode | Pi 1.5b is the ceiling on Hailo-10H HEF. Mac M4 handles 7b easily at full speed. |
| Thinking LLM | qwen2.5-instruct:1.5b<br>same model, thinking mode on | qwen2.5:14b-instruct-q4_K_M<br>via Ollama, reasoning mode | Pi: No bigger model available as HEF yet. Mac 14b fits in 16GB unified memory with headroom. |
| Function Model | gemma3:1b<br>CPU, via Ollama | gemma3:1b<br>CPU, via Ollama | Same ~270M, too small to benefit from Hailo. Fast on CPU either way. |
| **Vision** | | | |
| VLM | Qwen2-VL-2B-Instruct.hef<br>HailoRT Python API, NPU | llava:7b-v1.6-mistral-q4_K_M<br>via Ollama | Pi: HEF required, version must match hailort. Mac: Any llava-compatible model works. |
| Object detection | YOLO11s HEF preferred<br>drop to YOLO11n HEF if throughput requires it | YOLO11s<br>CPU/Metal | Keep one detector API across profiles. `pi_cpu` uses YOLO11n on CPU. |
| Face detection | SCRFD-10G HEF | SCRFD-10G | Keep SCRFD family across all profiles. `pi_cpu` uses SCRFD-500M on CPU. |
| Face recognition | ArcFace-compatible embeddings<br>CPU fallback required | ArcFace-compatible embeddings | Keep the embedding format consistent even when detection backends differ. |
| **Speech** | | | |
| STT | ggml-base.en<br>whisper.cpp, CPU | faster-whisper base.en<br>or medium.en for accuracy | Config swap: Both implement same interface. Try faster-whisper on Mac first; fall back to whisper.cpp if needed on Pi. |
| TTS | Piper en_US-cori-medium<br>CPU, sentence streaming | Piper en_US-cori-medium<br>or any medium voice | Same: Medium is the validated sweet spot. Small = robotic, large = too slow on Pi. |
| Wake Word | openWakeWord<br>custom .onnx, CPU | openWakeWord<br>CPU | Same: CPU only on all profiles. |

A few things worth calling out:
Pi is constrained by the HEF. The Hailo-10H only runs models that have been compiled into HEF format by Hailo. Right now qwen2.5-instruct:1.5b is the only validated LLM HEF available. You can't just pull a bigger Qwen model and expect it to run on the NPU — it has to exist as a HEF first. That's why be-more-hailo uses the same model for both fast and slow paths.
Mac M4 has no such ceiling. 7b non-thinking and 14b thinking is a comfortable split — both run at full Metal speed, fit in 16GB unified memory alongside the OS and your app, and give you noticeably better responses than the Pi's 1.5b.
gemma3:1b is the current Ollama name for the ~270M function-calling model — worth confirming the exact model string when you pull it, as Ollama naming conventions shift.
For real-time detection, standardize on the same model families rather than the exact same weights on every device: YOLO11s on Mac, YOLO11n on `pi_cpu`, and YOLO11s HEF on `pi_hailo` with YOLO11n HEF as the throughput fallback. For faces, use SCRFD-10G on Mac and `pi_hailo`, SCRFD-500M on `pi_cpu`, and keep ArcFace-compatible embeddings as the recognition contract everywhere.
Licensing is a real design input here, not paperwork to defer: Ultralytics YOLO11 and stock InsightFace assets may need commercial licensing or replacement weights depending on how LokiDoki is distributed.
