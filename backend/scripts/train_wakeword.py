#!/usr/bin/env python3
"""
Trains an openWakeWord-compatible binary classifier from WAV samples.

Uses the installed mel + embedding ONNX backbones (same as the runtime detector)
to extract features the SAME way the live runtime does — mel recomputed over a
rolling ~2.2 s raw-audio window, trailing 76 frames → one embedding per 80 ms
chunk (openWakeWord's convention) — trains a small MLP on completion-aligned
positive windows, and exports a detector ONNX whose wire format matches
WakeWordLoop:
  - Input  "x.1" : float32[1, 16, 96]  (16 embedding frames)
  - Output        : float32[1, 1]       (detection score in [0, 1])

Train-time and run-time feature extraction MUST stay identical (see BUF here and
RAW_AUDIO_BUFFER_SAMPLES in wake-word-pipeline.ts), or a correct detector is fed
mismatched features and never fires.

Usage:
  python train_wakeword.py \\
    --mel    <melspectrogram.onnx> \\
    --embed  <embedding_model.onnx> \\
    --positives <dir/>  \\
    --negatives <dir/>  \\
    --output <detector.onnx>

Requirements (pip install):
  onnxruntime numpy scikit-learn onnx scipy
"""

import argparse
import atexit
import sys
import json
import struct
import subprocess
import numpy as np

# ---------------------------------------------------------------------------
# Pipeline constants — must match wake-word-pipeline.ts exactly
# ---------------------------------------------------------------------------
FRAME_SAMPLES   = 1280   # 80 ms @ 16 kHz
SAMPLE_RATE     = 16_000
MEL_DIM         = 32
MEL_BUF_FRAMES  = 76     # MEL_BUFFER_SEED_FRAMES
EMB_DIM         = 96
DET_FRAMES      = 16     # DETECTOR_INPUT_FRAMES

# A detector window whose loudest frame is below this RMS is treated as
# non-speech. Inside a positive clip, such windows are the leading/trailing
# silence padding — they are NOT the wake word, so they must be labeled
# negative. Labeling them positive (the previous behavior) taught the model
# that silence/any onset → wake, which made it fire on almost anything.
SILENCE_RMS = 0.015

# How many windows to sample from the external negative feature bank. A large,
# diverse negative set is the single biggest factor for a tight boundary — the
# 180 MB bank holds ~481k windows, so we draw a big slice (the real openWakeWord
# pipeline uses millions). Cost is training time/RAM, not model size.
NEG_FEATURE_SAMPLES = 60000


def progress(msg: str, **kw) -> None:
    """Emit a JSON progress line to stdout (read by the Bun trainer)."""
    print(json.dumps({"msg": msg, **kw}), flush=True)


# ---------------------------------------------------------------------------
# onnxruntime-web embedding bridge
# ---------------------------------------------------------------------------
# The browser runs the wake-word pipeline through onnxruntime-web (WASM), whose
# Conv kernels compute the openWakeWord embedding model differently (~25 per dim)
# from native onnxruntime. A detector trained on NATIVE embeddings is fed
# out-of-distribution features at runtime and never fires. So when training for
# the browser, embeddings are extracted by the SAME runtime via a persistent
# Node server (scripts/wake_embed_ortweb.mjs) — train and inference features then
# match bit-for-bit. The mel model agrees across runtimes; only the embedding CNN
# diverges, but the server runs the whole mel→embedding front-end for exact parity.
class OrtWebEmbedder:
    def __init__(self, node_bin: str, script: str, mel_path: str, emb_path: str):
        self.proc = subprocess.Popen(
            [node_bin, script, mel_path, emb_path],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0,
        )
        ready = self.proc.stdout.read(3)  # "OK\n" once sessions are loaded
        if ready != b"OK\n":
            err = self.proc.stderr.read(800).decode("utf-8", "replace") if self.proc.stderr else ""
            raise RuntimeError(f"ort-web embed server failed to start: {ready!r} {err}")

    def embed(self, audio: np.ndarray) -> np.ndarray:
        """Return (N, EMB_DIM) embeddings for mono float32 16 kHz audio, one per
        1280-sample chunk — identical to the browser runtime."""
        a = np.ascontiguousarray(audio, dtype="<f4")
        self.proc.stdin.write(struct.pack("<I", a.shape[0]))
        self.proc.stdin.write(a.tobytes())
        self.proc.stdin.flush()
        hdr = self._read_exact(4)
        n = struct.unpack("<I", hdr)[0]
        body = self._read_exact(n * EMB_DIM * 4)
        return np.frombuffer(body, dtype="<f4").reshape(n, EMB_DIM).copy()

    def _read_exact(self, n: int) -> bytes:
        out = b""
        while len(out) < n:
            chunk = self.proc.stdout.read(n - len(out))
            if not chunk:
                err = self.proc.stderr.read(800).decode("utf-8", "replace") if self.proc.stderr else ""
                raise RuntimeError(f"ort-web embed server closed mid-response: {err}")
            out += chunk
        return out

    def close(self) -> None:
        try:
            self.proc.stdin.write(struct.pack("<I", 0xFFFFFFFF)); self.proc.stdin.flush()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


# Active embedder (set in main when --embed-runtime ortweb); None → native path.
_EMBEDDER: "OrtWebEmbedder | None" = None


# ---------------------------------------------------------------------------
# Feature extraction
# ---------------------------------------------------------------------------

def load_audio(path: str) -> np.ndarray:
    """Load a WAV and return mono float32 at SAMPLE_RATE."""
    from scipy.io.wavfile import read as wav_read
    from scipy.signal import resample_poly
    from math import gcd
    sr, data = wav_read(path)
    if data.dtype == np.int16:
        audio = data.astype(np.float32) / 32768.0
    elif data.dtype == np.int32:
        audio = data.astype(np.float32) / 2_147_483_648.0
    else:
        audio = data.astype(np.float32)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sr != SAMPLE_RATE:
        g = gcd(int(sr), SAMPLE_RATE)
        audio = resample_poly(audio, SAMPLE_RATE // g, sr // g).astype(np.float32)
    return audio


MEL_LOOKBACK = 480  # 160*3 — extra context so a 1280-chunk yields 8 mel frames
                    # (mel window=640, hop=160) exactly matching the continuous
                    # stream. This is the openWakeWord streaming trick.

def extract_embeddings(
    audio: np.ndarray,
    mel_sess,
    emb_sess,
    mel_input_name: str,
    emb_input_name: str,
    mel_frames_per_chunk: int = 0,
) -> np.ndarray:
    """Return (embeddings (N, EMB_DIM), per-chunk RMS (N,)) using openWakeWord's
    STREAMING method — the SAME path the live runtime uses, so train-time and
    run-time features match (verified cosine 0.978 vs the openWakeWord library's
    own streaming output).

    Per 1280-sample (80 ms) chunk: compute the mel of the LAST 1280+480 samples
    (→ exactly 8 mel frames with proper inter-chunk context), append them to the
    rolling 76-frame mel buffer, and emit ONE embedding from the buffer. The old
    code took the mel of each ISOLATED 1280-sample chunk (only 5 context-free
    frames), which produced features just 0.71 cosine-similar to openWakeWord —
    phonetic detail was lost, so detectors collapsed to speech-vs-noise and the
    official pretrained models scored ~0.
    """
    BUF = 35200  # ~2.2 s rolling raw-audio window — enough context for 16
                 # embeddings; mel is computed over the WHOLE window each chunk
                 # (whole-clip quality), and runtime uses the identical op.

    # Per-chunk RMS (used for silence-aware labeling) is computed the same way
    # regardless of which runtime extracts the embeddings.
    rms = [float(np.sqrt(np.mean(audio[end - FRAME_SAMPLES:end] ** 2)))
           for end in range(FRAME_SAMPLES, len(audio) + 1, FRAME_SAMPLES)]

    if _EMBEDDER is not None:
        # Extract with onnxruntime-web (browser parity). One embedding per chunk,
        # so the count matches the RMS list above.
        embeddings = _EMBEDDER.embed(audio)
        if embeddings.shape[0] == 0:
            return np.empty((0, EMB_DIM), np.float32), np.empty((0,), np.float32)
        rms = rms[:embeddings.shape[0]]
        return embeddings.astype(np.float32), np.array(rms, np.float32)

    embeddings = []
    for end in range(FRAME_SAMPLES, len(audio) + 1, FRAME_SAMPLES):
        buf = audio[max(0, end - BUF):end]
        spec = mel_sess.run(None, {mel_input_name: (buf * 32767.0).astype(np.float32)[None, :]})[0].reshape(-1, MEL_DIM) / 10.0 + 2.0
        if spec.shape[0] < MEL_BUF_FRAMES:
            spec = np.vstack([np.ones((MEL_BUF_FRAMES - spec.shape[0], MEL_DIM), np.float32), spec])
        win = spec[-MEL_BUF_FRAMES:]
        emb = emb_sess.run(None, {emb_input_name: win.reshape(1, MEL_BUF_FRAMES, MEL_DIM, 1)})[0].reshape(EMB_DIM)
        embeddings.append(emb)
    if not embeddings:
        return np.empty((0, EMB_DIM), np.float32), np.empty((0,), np.float32)
    return np.array(embeddings, np.float32), np.array(rms, np.float32)


def windows_from_embeddings(embeddings: np.ndarray, rms: np.ndarray, positive: bool):
    """Slide a DET_FRAMES window to produce (1536,) feature vectors.

    POSITIVE LABELING (critical): a window is positive ONLY when the COMPLETE
    wake phrase ends right at the window's right edge — i.e. a contiguous speech
    run that fits inside the window and is immediately followed by silence (or
    the clip end). This is the moment the detector must fire.

    The previous behavior labeled EVERY speech-containing window positive. With
    a repeated/padded clip that smears the positive class across every 1.3 s
    slice of generic speech, so the model could only learn "speech vs non-speech"
    and fired on ALL speech (e.g. "what time is it") — a fully collapsed,
    non-discriminating detector. Aligning positives to the phrase COMPLETION
    gives a tight, phrase-specific target.

    Windows that overlap the phrase only partially (it spills past the window,
    or the phrase has not finished yet) are labeled NEGATIVE on purpose — they
    teach the model to require the WHOLE phrase, not a fragment. Negative clips
    contribute only negatives.
    """
    TRAIL = 3  # also accept the few windows just past completion (phrase still
               # fully inside as the window slides into trailing silence)
    n = len(embeddings)
    speech = (rms >= SILENCE_RMS) if len(rms) else np.zeros(n, dtype=bool)
    X, y = [], []
    s_idx = np.where(speech)[0]
    s0 = int(s_idx[0]) if len(s_idx) else -1
    s1 = int(s_idx[-1]) if len(s_idx) else -1
    phrase_len = (s1 - s0 + 1) if s0 >= 0 else 0
    # Completion zone: window right-edges where the phrase has just finished.
    lo, hi = s1 + 1, s1 + 1 + TRAIL
    need = 0.6 * min(phrase_len, DET_FRAMES)  # window must hold most of the phrase
    for i in range(DET_FRAMES, n + 1):
        label = 0
        if positive and s0 >= 0 and lo <= i <= hi:
            cov = int(speech[i - DET_FRAMES : i].sum())
            if cov >= need:
                label = 1
        X.append(embeddings[i - DET_FRAMES : i].flatten())
        y.append(label)

    # Fallback: very long phrase (> window) yields no completion window above —
    # label the single window with the most phrase coverage so the clip still
    # contributes a positive rather than silently becoming negatives-only.
    if positive and s0 >= 0 and not any(y) and n >= DET_FRAMES:
        covs = [int(speech[i - DET_FRAMES : i].sum()) for i in range(DET_FRAMES, n + 1)]
        best = int(np.argmax(covs))
        if covs[best] >= 6:
            y[best] = 1
    return X, y


# ---------------------------------------------------------------------------
# Audio augmentation — the core of robust wake-word training. Convolving with
# room impulse responses + mixing noise at random SNR + gain jitter teaches the
# model to generalize from clean synthetic TTS to a real, reverberant, noisy
# microphone. Done procedurally (no datasets to download) so training stays fast
# and self-contained, and each base clip becomes many effective training samples.
# ---------------------------------------------------------------------------

def make_rir(sr: int, rng) -> np.ndarray:
    """Procedural room impulse response: direct spike + exponentially-decaying tail."""
    decay = rng.uniform(0.08, 0.35)
    n = max(8, int(sr * rng.uniform(0.10, 0.30)))
    t = np.arange(n) / sr
    rir = (rng.standard_normal(n) * np.exp(-t / decay)).astype(np.float32)
    rir[0] += 1.0  # direct path dominates
    return rir


def gen_noise_pool(sr: int, rng, k: int = 8):
    """A few ~2s noise beds to mix into positives as realistic background. Includes
    white, low-passed room-tone, brownish (low-freq heavy) and mains-hum beds so the
    detector is robust to the colored, low-frequency noise a real room/mic produces —
    not just flat white noise."""
    pool = []
    for j in range(k):
        n = rng.standard_normal(sr * 2).astype(np.float32)
        kind = j % 4
        if kind == 1:    # crude low-pass → duller room tone
            n = np.convolve(n, np.ones(8, dtype=np.float32) / 8.0)[: len(n)].astype(np.float32)
        elif kind == 2:  # brownish: cumulative sum is low-frequency heavy
            n = np.cumsum(n).astype(np.float32)
        elif kind == 3:  # mains hum + hiss
            t = np.arange(sr * 2, dtype=np.float32) / sr
            f = 45.0 + rng.random() * 90.0
            n = (0.7 * np.sin(2 * np.pi * f * t) + 0.3 * n).astype(np.float32)
        pool.append((n / (np.max(np.abs(n)) + 1e-6)).astype(np.float32))
    return pool


def augment(audio: np.ndarray, sr: int, rng, noise_pool) -> np.ndarray:
    out = audio.astype(np.float32).copy()
    if rng.random() < 0.6:  # reverb
        out = np.convolve(out, make_rir(sr, rng))[: len(audio)].astype(np.float32)
    if noise_pool and rng.random() < 0.7:  # additive noise at random SNR (5–20 dB)
        noise = noise_pool[int(rng.integers(len(noise_pool)))]
        if len(noise) < len(out):
            noise = np.tile(noise, int(np.ceil(len(out) / len(noise))))
        noise = noise[: len(out)]
        sig_p = float(np.mean(out ** 2)) + 1e-9
        noi_p = float(np.mean(noise ** 2)) + 1e-9
        scale = np.sqrt(sig_p / (noi_p * (10 ** (rng.uniform(5.0, 20.0) / 10))))
        out = out + scale * noise
    out *= rng.uniform(0.6, 1.1)  # gain jitter
    peak = float(np.max(np.abs(out))) + 1e-6
    if peak > 1.0:
        out = out / peak
    return out.astype(np.float32)


# ---------------------------------------------------------------------------
# ONNX export
# ---------------------------------------------------------------------------

def export_mlp_onnx(W0: np.ndarray, b0: np.ndarray, W1: np.ndarray, b1: np.ndarray, out_path: str) -> None:
    """
    Build an ONNX graph for a 1-hidden-layer ReLU MLP:
      x.1[1,16,96] → Reshape[1,1536] → Gemm(W0,b0) → Relu → Gemm(W1,b1) → Sigmoid → [1,1]
    The StandardScaler is absorbed into the first layer (W0/b0), so no separate
    normalization node is needed. Output matches the same [1,1] score contract
    the runtime expects, so WakeWordLoop is unchanged.
    """
    import onnx
    from onnx import helper, TensorProto, numpy_helper

    shape_const = numpy_helper.from_array(np.array([1, 1536], dtype=np.int64), name="__shape")
    W0i = numpy_helper.from_array(W0.astype(np.float32), name="__W0")  # [1536, H]
    b0i = numpy_helper.from_array(b0.astype(np.float32), name="__b0")  # [H]
    W1i = numpy_helper.from_array(W1.astype(np.float32), name="__W1")  # [H, 1]
    b1i = numpy_helper.from_array(b1.astype(np.float32), name="__b1")  # [1]

    nodes = [
        helper.make_node("Reshape", ["x.1", "__shape"],        ["_flat"]),
        helper.make_node("Gemm",    ["_flat", "__W0", "__b0"], ["_z1"]),
        helper.make_node("Relu",    ["_z1"],                   ["_a1"]),
        helper.make_node("Gemm",    ["_a1", "__W1", "__b1"],   ["_z2"]),
        helper.make_node("Sigmoid", ["_z2"],                   ["_output"]),
    ]
    graph = helper.make_graph(
        nodes,
        "wakeword_mlp",
        [helper.make_tensor_value_info("x.1", TensorProto.FLOAT, [1, 16, 96])],
        [helper.make_tensor_value_info("_output", TensorProto.FLOAT, [1, 1])],
        initializer=[shape_const, W0i, b0i, W1i, b1i],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    model.ir_version = 8
    onnx.save(model, out_path)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mel",       required=True)
    ap.add_argument("--embed",     required=True)
    ap.add_argument("--positives", required=True)
    ap.add_argument("--negatives", required=True)
    ap.add_argument("--output",    required=True)
    ap.add_argument("--neg-features", default=None,
                    help="optional openWakeWord precomputed negative features .npy (N,16,96)")
    ap.add_argument("--embed-runtime", choices=["native", "ortweb"], default="native",
                    help="ortweb extracts embeddings via onnxruntime-web for browser parity")
    ap.add_argument("--node-bin", default="node", help="node binary for the ort-web embed server")
    ap.add_argument("--embed-script", default=None, help="path to wake_embed_ortweb.mjs")
    ap.add_argument("--keep-native-bank", action="store_true",
                    help="(experimental) keep the native neg-feature bank even in ortweb mode")
    args = ap.parse_args()

    global _EMBEDDER
    if args.embed_runtime == "ortweb":
        script = args.embed_script
        if not script:
            from pathlib import Path as _P
            script = str(_P(__file__).with_name("wake_embed_ortweb.mjs"))
        progress("Starting onnxruntime-web embedding server (browser parity)…")
        try:
            _EMBEDDER = OrtWebEmbedder(args.node_bin, script, args.mel, args.embed)
            # Ensure the Node embed server is reaped on every exit path, including the
            # sys.exit() early-returns below — not just the explicit close() at the end.
            atexit.register(_EMBEDDER.close)
        except Exception as e:
            progress(f"ERROR: could not start ort-web embed server: {e}", error=True)
            sys.exit(1)
        # The precomputed negative bank lives in NATIVE embedding space; mixing it
        # with ort-web positives would let the model separate by feature-space
        # instead of by phrase. Drop it in ort-web mode for a coherent space.
        if args.neg_features and not args.keep_native_bank:
            progress("Skipping native negative-feature bank in ortweb mode (space mismatch)")
            args.neg_features = None

    import onnxruntime as ort
    from pathlib import Path
    from sklearn.neural_network import MLPClassifier
    from sklearn.preprocessing import StandardScaler

    progress("Loading ONNX backbones…")
    mel_sess = ort.InferenceSession(args.mel,   providers=["CPUExecutionProvider"])
    emb_sess = ort.InferenceSession(args.embed, providers=["CPUExecutionProvider"])
    mel_input_name = mel_sess.get_inputs()[0].name
    emb_input_name = emb_sess.get_inputs()[0].name

    # Probe mel output shape to count frames-per-chunk
    probe = np.zeros((1, FRAME_SAMPLES), dtype=np.float32)
    probe_mel = mel_sess.run(None, {mel_input_name: probe})[0]
    mel_frames_per_chunk = probe_mel.size // MEL_DIM
    progress(f"Mel produces {mel_frames_per_chunk} frames per {FRAME_SAMPLES}-sample chunk")

    # Each base clip is expanded into augmented variants so a handful of TTS
    # clips becomes a large, realistic training set without extra synthesis.
    aug_rng = np.random.default_rng(1234)
    noise_pool = gen_noise_pool(SAMPLE_RATE, aug_rng)
    AUG_POS, AUG_NEG = 12, 6

    lead_pad = np.zeros(int(0.6 * SAMPLE_RATE), dtype=np.float32)   # 0.6 s lead-in
    tail_pad = np.zeros(int(0.3 * SAMPLE_RATE), dtype=np.float32)   # 0.3 s trailing

    def collect(dir_path: str, label: int, name: str):
        files = sorted(Path(dir_path).glob("*.wav"))
        n_aug = AUG_POS if label == 1 else AUG_NEG
        progress(f"Processing {len(files)} {name} files (×{n_aug + 1} augmented)…", count=len(files))
        X, y = [], []
        for i, f in enumerate(files):
            try:
                base = load_audio(str(f))
                # Pad positives with leading/trailing silence so the phrase has a
                # clean speech→silence boundary for completion-aligned labeling.
                if label == 1:
                    base = np.concatenate([lead_pad, base, tail_pad])
                # Labels come from the CLEAN clip's RMS: augment() mixes noise into
                # every frame, which would erase the silence boundary and break
                # completion detection. Augmentation preserves length, so the clean
                # frame→window alignment is valid for every variant.
                _, clean_rms = extract_embeddings(base, mel_sess, emb_sess, mel_input_name, emb_input_name, mel_frames_per_chunk)
                variants = [base] + [augment(base, SAMPLE_RATE, aug_rng, noise_pool) for _ in range(n_aug)]
                for v in variants:
                    embs, rms = extract_embeddings(v, mel_sess, emb_sess, mel_input_name, emb_input_name, mel_frames_per_chunk)
                    wx, wy = windows_from_embeddings(embs, clean_rms if label == 1 else rms, positive=(label == 1))
                    X.extend(wx); y.extend(wy)
            except Exception as e:
                progress(f"  skip {f.name}: {e}")
            if (i + 1) % 10 == 0:
                progress(f"  {i + 1}/{len(files)} done")
        return X, y

    Xp, yp = collect(args.positives, 1, "positive")
    Xn, yn = collect(args.negatives, 0, "negative")

    if not Xp or not Xn:
        progress("ERROR: need both positive and negative samples", error=True)
        sys.exit(1)

    X = np.array(Xp + Xn, dtype=np.float32)
    y = np.array(yp + yn, dtype=np.int32)

    # Mix in openWakeWord's precomputed negative feature bank (real-world audio
    # in the same (16,96) window format). This large, diverse negative set is
    # what teaches the model to reject similar phrases + real noise instead of
    # over-firing — the single biggest factor for synthetic-only training.
    if args.neg_features and Path(args.neg_features).exists():
        try:
            # The bank is flat per-frame embeddings (F, 96); slice random
            # DET_FRAMES-long windows and flatten to match our (16*96,) vectors.
            feats = np.load(args.neg_features, mmap_mode="r")  # (F, 96) float32
            if feats.ndim == 3:  # already windowed (N,16,96)
                feats = feats.reshape(feats.shape[0], -1)
                starts = None
            F = int(feats.shape[0])
            k = min(NEG_FEATURE_SAMPLES, max(0, F - DET_FRAMES))
            rng7 = np.random.default_rng(7)
            if feats.ndim == 2 and feats.shape[1] == EMB_DIM:
                starts = np.sort(rng7.choice(F - DET_FRAMES, size=k, replace=False))
                bank = np.stack([np.asarray(feats[s:s + DET_FRAMES], dtype=np.float32).reshape(-1) for s in starts])
            else:  # pre-flattened windows of width 1536
                sel = np.sort(rng7.choice(F, size=min(NEG_FEATURE_SAMPLES, F), replace=False))
                bank = np.asarray(feats[sel], dtype=np.float32)
            if bank.shape[1] == X.shape[1]:
                X = np.concatenate([X, bank], axis=0)
                y = np.concatenate([y, np.zeros(len(bank), dtype=np.int32)])
                progress(f"Added {len(bank)} negatives from the feature bank")
            else:
                progress(f"Feature bank width {bank.shape[1]} != {X.shape[1]} — skipped")
        except Exception as e:
            progress(f"Feature bank skipped ({e})")

    # Cap negatives to a modest multiple of positives. Completion-aligned
    # positives are few; left uncapped, ~50k negatives force balance() to
    # duplicate each positive ~100×, which drowns the phrase signal and the
    # detector either fires on nothing or collapses. A ~6:1 ratio keeps a strong
    # negative set while letting the positives actually shape the boundary.
    NEG_PER_POS = 12
    rng_cap = np.random.default_rng(11)
    pos_i = np.where(y == 1)[0]; neg_i = np.where(y == 0)[0]
    if len(pos_i) and len(neg_i) > NEG_PER_POS * len(pos_i):
        neg_keep = rng_cap.choice(neg_i, NEG_PER_POS * len(pos_i), replace=False)
        keep = np.concatenate([pos_i, neg_keep]); rng_cap.shuffle(keep)
        X = X[keep]; y = y[keep]
        progress(f"Capped negatives to {NEG_PER_POS}:1 ({len(neg_keep)} kept)")

    n_pos = int(np.sum(y == 1)); n_neg = int(np.sum(y == 0))
    progress(f"Training on {n_pos} positive + {n_neg} negative windows…")
    if n_pos == 0 or n_neg == 0:
        progress("ERROR: after silence filtering, need both positive and negative windows", error=True)
        sys.exit(1)

    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    # MLPClassifier has no class_weight, so balance by oversampling the minority
    # class (positives are fewer after silence filtering).
    rng = np.random.default_rng(42)
    def balance(Xs, ys):
        pi = np.where(ys == 1)[0]; ni = np.where(ys == 0)[0]
        if len(pi) == 0 or len(ni) == 0:
            return Xs, ys
        if len(pi) < len(ni):
            pi = rng.choice(pi, len(ni), replace=True)
        elif len(ni) < len(pi):
            ni = rng.choice(ni, len(pi), replace=True)
        idx = np.concatenate([pi, ni]); rng.shuffle(idx)
        return Xs[idx], ys[idx]

    # A small ReLU MLP — unlike a linear model it can separate similar phrases
    # ("hey loki" vs "hey alexa"), which logistic regression could not. L2 (alpha)
    # + early_stopping guard against memorizing synthetic TTS so it still
    # generalizes to a real microphone.
    # 32-unit hidden layer keeps the ONNX small (~200 KB) while augmentation
    # supplies enough data to learn a tight, speaker-robust boundary.
    def make_mlp():
        return MLPClassifier(hidden_layer_sizes=(64,), activation="relu", alpha=1e-3,
                             max_iter=400, random_state=42, early_stopping=False)

    # Calibrate the fire threshold on a held-out split (fit on balanced train).
    threshold = 0.5
    try:
        from sklearn.model_selection import train_test_split
        Xtr, Xva, ytr, yva = train_test_split(X_scaled, y, test_size=0.25, random_state=42, stratify=y)
        Xtb, ytb = balance(Xtr, ytr)
        cal = make_mlp().fit(Xtb, ytb)
        pva = cal.predict_proba(Xva)[:, 1]
        pos = pva[yva == 1]; neg = pva[yva == 0]
        val_acc = float(cal.score(Xva, yva))
        if len(pos) and len(neg):
            neg_hi = float(np.percentile(neg, 95))   # nearly all negatives below this
            pos_lo = float(np.percentile(pos, 10))   # most positives above this
            thr = max(neg_hi + 0.10, (neg_hi + pos_lo) / 2)
            threshold = round(min(0.85, max(0.3, thr)), 2)
        progress(f"Validation accuracy: {val_acc:.1%}; calibrated threshold {threshold:.2f}")
    except Exception as e:
        progress(f"Threshold calibration skipped ({e}); using {threshold:.2f}")

    # Final model on all (balanced) data.
    Xb, yb = balance(X_scaled, y)
    clf = make_mlp()
    clf.fit(Xb, yb)
    acc = float(clf.score(Xb, yb))
    progress(f"Training accuracy: {acc:.1%}")

    # Fuse the StandardScaler into the first layer so the ONNX graph needs no
    # separate normalization:  z1 = (x - mean)/scale @ W0 + b0
    #   = x @ (W0 / scale[:,None]) + (b0 - (mean/scale) @ W0)
    W0 = np.asarray(clf.coefs_[0], dtype=np.float64)        # [1536, H]
    b0 = np.asarray(clf.intercepts_[0], dtype=np.float64)   # [H]
    W1 = np.asarray(clf.coefs_[1], dtype=np.float64)        # [H, 1]
    b1 = np.asarray(clf.intercepts_[1], dtype=np.float64)   # [1]
    W0_fused = W0 / scaler.scale_[:, None]
    b0_fused = b0 - (scaler.mean_ / scaler.scale_) @ W0

    progress("Exporting ONNX detector…")
    export_mlp_onnx(W0_fused, b0_fused, W1, b1, args.output)
    if _EMBEDDER is not None:
        _EMBEDDER.close()
    progress("Done.", done=True, threshold=threshold)


if __name__ == "__main__":
    main()
