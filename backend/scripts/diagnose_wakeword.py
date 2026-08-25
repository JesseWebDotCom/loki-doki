#!/usr/bin/env python3
"""
Wake-word diagnostic harness.

Replicates the BROWSER RUNTIME inference pipeline (frontend/src/lib/voice/
wake-word-loop.ts) exactly — rolling 76-frame mel buffer seeded with ones,
one embedding per 80 ms frame, detector over the trailing 16 embeddings — so we
can measure the real per-frame detector score a given .onnx produces on a given
utterance, the same number that fires hands-free in production.

Usage:
  python diagnose_wakeword.py --wakeword-dir <dir> \
      --voice-server http://localhost:8091 \
      [--detector <file.onnx>] [--phrase "hey maipai"] [--voices am_santa,af_heart,...]

With no --detector it runs the validation sweep: hey_jarvis vs "hey jarvis"
(known-good, proves the harness is faithful) then the trained detector(s).
"""

import argparse, json, sys, urllib.request
from pathlib import Path
import numpy as np

FRAME_SAMPLES = 1280
SR = 16_000
MEL_DIM = 32
MEL_BUF_FRAMES = 76
EMB_DIM = 96
DET_FRAMES = 16
WARMUP_ZERO_FRAMES = 5


def load_wav_bytes(raw: bytes) -> np.ndarray:
    """Decode a WAV (any rate/dtype) to mono float32 @ 16 kHz — matches load_audio."""
    from scipy.io.wavfile import read as wav_read
    from scipy.signal import resample_poly
    from math import gcd
    import io
    sr, data = wav_read(io.BytesIO(raw))
    if data.dtype == np.int16:
        audio = data.astype(np.float32) / 32768.0
    elif data.dtype == np.int32:
        audio = data.astype(np.float32) / 2_147_483_648.0
    else:
        audio = data.astype(np.float32)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sr != SR:
        g = gcd(int(sr), SR)
        audio = resample_poly(audio, SR // g, sr // g).astype(np.float32)
    return audio.astype(np.float32)


def synthesize(server: str, text: str, voice: str, speed: float = 1.0) -> np.ndarray:
    body = json.dumps({"text": text, "voice": voice, "speed": speed}).encode()
    req = urllib.request.Request(server + "/synthesize", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return load_wav_bytes(r.read())


RAW_BUF = 35_200  # ~2.2 s — must equal RAW_AUDIO_BUFFER_SAMPLES (runtime) / BUF (trainer)

def run_pipeline(audio, mel_sess, emb_sess, det_sess, mel_in, emb_in, det_in):
    """Stream `audio` through mel→embedding→detector exactly like the JS runtime.

    Per 1280-sample (80 ms) chunk: recompute the mel over the trailing ~2.2 s of
    raw audio (whole-window, so STFT frames have full context), take the last 76
    mel frames → one embedding, slide the 16-embedding detector window. This is
    openWakeWord's feature convention and matches train_wakeword.py exactly.
    ~1 s of leading silence is prepended so the detector window is fully populated
    by the time the phrase arrives, mirroring the always-full live buffer.
    """
    audio = np.concatenate([np.zeros(SR, np.float32), audio, np.zeros(SR // 2, np.float32)])
    # JS seeds the embedding ring with tiny noise; value is irrelevant once warm.
    emb_ring = (np.random.default_rng(0xA17C0001).random((DET_FRAMES, EMB_DIM)) - 0.5).astype(np.float32) * 0.02
    scores = []
    fi = 0
    for end in range(FRAME_SAMPLES, len(audio) + 1, FRAME_SAMPLES):
        buf = audio[max(0, end - RAW_BUF):end]
        spec = mel_sess.run(None, {mel_in: (buf * 32767.0).astype(np.float32)[None, :]})[0].reshape(-1, MEL_DIM) / 10.0 + 2.0
        if spec.shape[0] < MEL_BUF_FRAMES:
            spec = np.vstack([np.ones((MEL_BUF_FRAMES - spec.shape[0], MEL_DIM), np.float32), spec])
        win = spec[-MEL_BUF_FRAMES:]
        emb = emb_sess.run(None, {emb_in: win.reshape(1, MEL_BUF_FRAMES, MEL_DIM, 1)})[0].reshape(EMB_DIM)
        emb_ring = np.roll(emb_ring, -1, axis=0); emb_ring[-1] = emb
        out = det_sess.run(None, {det_in: emb_ring.reshape(1, DET_FRAMES, EMB_DIM).astype(np.float32)})[0]
        score = float(np.ravel(out)[-1])
        scores.append(0.0 if fi < WARMUP_ZERO_FRAMES else score)
        fi += 1
    return np.array(scores, dtype=np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wakeword-dir", required=True)
    ap.add_argument("--voice-server", default="http://localhost:8091")
    ap.add_argument("--detector", default=None, help="specific detector .onnx (basename)")
    ap.add_argument("--phrase", default="hey maipai")
    ap.add_argument("--train-voice", default="am_santa", help="voice the detector was trained on")
    ap.add_argument("--voices", default=None, help="comma list; default = a diverse sample")
    args = ap.parse_args()

    import onnxruntime as ort
    wd = Path(args.wakeword_dir)
    mel_sess = ort.InferenceSession(str(wd / "melspectrogram.onnx"), providers=["CPUExecutionProvider"])
    emb_sess = ort.InferenceSession(str(wd / "embedding_model.onnx"), providers=["CPUExecutionProvider"])
    mel_in = mel_sess.get_inputs()[0].name
    emb_in = emb_sess.get_inputs()[0].name

    def score_for(det_path, phrase, voice, speed=1.0):
        det_sess = ort.InferenceSession(str(det_path), providers=["CPUExecutionProvider"])
        det_in = det_sess.get_inputs()[0].name
        audio = synthesize(args.voice_server, phrase, voice, speed)
        s = run_pipeline(audio, mel_sess, emb_sess, det_sess, mel_in, emb_in, det_in)
        # peak and the mean of the top-5 frames (a sustained burst, like a real fire)
        top5 = float(np.mean(np.sort(s)[-5:])) if len(s) >= 5 else float(np.max(s) if len(s) else 0)
        return float(np.max(s) if len(s) else 0), top5

    default_voices = ["am_santa", "af_heart", "af_bella", "am_adam", "am_michael",
                      "bf_emma", "bm_george", "af_nicole", "am_eric", "af_sarah"]
    voices = (args.voices.split(",") if args.voices else default_voices)

    # ── 1. Harness validation: known-good pretrained model ───────────────────
    print("\n" + "=" * 64)
    print("VALIDATION — hey_jarvis pretrained model vs 'hey jarvis'")
    print("(peaks should be HIGH ~0.7-1.0 across voices; proves the harness")
    print(" reproduces the real runtime before we trust any other numbers)")
    print("=" * 64)
    jarvis = wd / "hey_jarvis_v0.1.onnx"
    if jarvis.exists():
        print(f"{'voice':<14}{'peak':>8}{'top5':>8}")
        for v in voices:
            try:
                pk, t5 = score_for(jarvis, "hey jarvis", v)
                print(f"{v:<14}{pk:>8.3f}{t5:>8.3f}")
            except Exception as e:
                print(f"{v:<14}  err: {e}")
    else:
        print("(hey_jarvis_v0.1.onnx not installed — skipping validation)")

    # ── 2. The trained detector(s) under test ────────────────────────────────
    if args.detector:
        detectors = [wd / args.detector]
    else:
        detectors = sorted(wd.glob("trained_*.onnx"))
    for det in detectors:
        print("\n" + "=" * 64)
        print(f"TRAINED DETECTOR — {det.name}")
        print(f"phrase: '{args.phrase}'   (trained voice: {args.train_voice})")
        print("if the trained voice scores HIGH but others LOW → single-voice overfit")
        print("if EVERYTHING scores low → collapsed model / training or parity bug")
        print("=" * 64)
        print(f"{'voice':<14}{'peak':>8}{'top5':>8}   note")
        for v in voices:
            try:
                pk, t5 = score_for(det, args.phrase, v)
                note = "  <- TRAIN VOICE" if v == args.train_voice else ""
                print(f"{v:<14}{pk:>8.3f}{t5:>8.3f}{note}")
            except Exception as e:
                print(f"{v:<14}  err: {e}")
        # negative control: an unrelated phrase should score low
        try:
            pk, t5 = score_for(det, "what time is it", args.train_voice)
            print(f"{'(neg ctrl)':<14}{pk:>8.3f}{t5:>8.3f}   unrelated phrase, same voice")
        except Exception as e:
            print(f"(neg ctrl) err: {e}")


if __name__ == "__main__":
    main()
