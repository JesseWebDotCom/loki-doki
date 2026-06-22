# (wake-word models are no longer bundled here)

Wake-word ONNX models are downloaded at runtime by the backend (Admin → Voice →
Wake word browser, or the "Wake Word" item in the Features panel) into
`data/voice/wakewords/`, and served at `/api/voice/wakeword/*`.

Only the ONNX **runtime** (`onnxruntime-web`) WASM lives in the build, under
`frontend/public/ort/`. This directory is intentionally empty.
