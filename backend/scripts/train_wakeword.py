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
import os
import re
import sys
import json
import struct
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
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

# Runtime fire-logic constants, MUST match wake-word-loop.ts / lib/pod/wake.ts and
# the eval harness (wakewordEvalCore.countFires). Calibration replays these over
# ordered score streams so the chosen threshold reflects real detection EVENTS, not
# raw per-window threshold crossings (which over-count by ~an order of magnitude).
SCORE_SMOOTHING_FRAMES = 4     # trailing moving-average window
REFRACTORY_MS          = 1000  # post-fire lockout
FRAME_MS               = 80    # per detector hop
HYST_BROWSER           = 2     # consecutive smoothed frames to fire (browser surface)
HYST_POD               = 4     # consecutive smoothed frames to fire (pod surface)

# Certification gate (per the wakeword design doc). A model must clear BOTH on the
# browser surface or it is not shipped: FA/hr on held-out REAL audio at or below
# TARGET, and isolated-clip recall at or above the floor. Emitted as gate_pass so the
# Bun trainer / companionWake can refuse to attach a failing detector.
GATE_TARGET_FAPH   = 1.0
GATE_RECALL_FLOOR  = 0.85

# A detector window whose loudest frame is below this RMS is treated as
# non-speech. Inside a positive clip, such windows are the leading/trailing
# silence padding — they are NOT the wake word, so they must be labeled
# negative. Labeling them positive (the previous behavior) taught the model
# that silence/any onset → wake, which made it fire on almost anything.
SILENCE_RMS = 0.015

# How many parallel ort-web embedder subprocesses to run in --embed-runtime
# ortweb mode. Each is single-threaded WASM (matches the single-threaded
# browser, which has no crossOriginIsolated headers), so this parallelizes
# ACROSS independent files/variants rather than speeding up any one embedding
# call — real, multi-minute audio files (see --calib-dir / real-noise training
# negatives) were the dominant cost, and were running one-at-a-time on a single
# core while the rest of the machine sat idle. Leaves 2 cores for the Python
# main thread + OS + whatever else is running on the box (this machine also
# runs the backend dev server, Ollama, ComfyUI, etc. concurrently).
EMBED_POOL_SIZE = max(1, min((os.cpu_count() or 4) - 2, 12))

# How many windows to sample from the external negative feature bank. A large,
# diverse negative set is the single biggest factor for a tight boundary — the
# 180 MB bank holds ~481k windows, so we draw a big slice (the real openWakeWord
# pipeline uses millions). Cost is training time/RAM, not model size.
NEG_FEATURE_SAMPLES = 60000


_progress_lock = threading.Lock()


def progress(msg: str, **kw) -> None:
    """Emit a JSON progress line to stdout (read by the Bun trainer). Locked since
    collect() now calls this from a thread pool — two interleaved prints could
    otherwise corrupt a JSON line the Bun side parses per newline."""
    with _progress_lock:
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


class EmbedderPool:
    """A pool of independent OrtWebEmbedder subprocesses so collect() can process
    many files' worth of embeddings in parallel across CPU cores.

    Each subprocess runs onnxruntime-web WASM single-threaded — identical to the
    browser runtime, which has no crossOriginIsolated headers and therefore also
    runs single-threaded (verified: no COOP/COEP headers anywhere in this app).
    Enabling onnxruntime-web's OWN internal multi-threading was considered and
    rejected: it would make training numerically diverge from the (single-
    threaded) browser again — the exact bug this ortweb-parity setup exists to
    avoid — for a speed win that's redundant with this pool anyway. Running many
    single-threaded subprocesses concurrently gets the CPU parallelism without
    touching the numerics of any individual embedding call at all.
    """

    def __init__(self, node_bin: str, script: str, mel_path: str, emb_path: str, size: int):
        self._all = [OrtWebEmbedder(node_bin, script, mel_path, emb_path) for _ in range(size)]
        self._free: "list[OrtWebEmbedder]" = list(self._all)
        self._cond = threading.Condition()

    def acquire(self) -> OrtWebEmbedder:
        with self._cond:
            while not self._free:
                self._cond.wait()
            return self._free.pop()

    def release(self, embedder: OrtWebEmbedder) -> None:
        with self._cond:
            self._free.append(embedder)
            self._cond.notify()

    def close(self) -> None:
        for e in self._all:
            e.close()


# Active embedder (set in main when --embed-runtime ortweb); None → native path.
# Used directly by call sites that don't participate in the parallel pool below
# (e.g. real-audio threshold calibration, which scores sequentially).
_EMBEDDER: "OrtWebEmbedder | None" = None
# Pool of embedders for collect()'s parallel file dispatch; None → sequential
# (native path, or ortweb with a pool size of 1).
_EMBEDDER_POOL: "EmbedderPool | None" = None


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
    embedder: "OrtWebEmbedder | None" = None,
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

    active_embedder = embedder if embedder is not None else _EMBEDDER
    if active_embedder is not None:
        # Extract with onnxruntime-web (browser parity). One embedding per chunk,
        # so the count matches the RMS list above. `embedder`, when given, routes
        # to a specific pooled instance (see EmbedderPool) instead of the shared
        # module-level _EMBEDDER — required for parallel dispatch across files,
        # since two threads sharing one subprocess would interleave the binary
        # stdin/stdout protocol and corrupt it.
        embeddings = active_embedder.embed(audio)
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


def score_real_negatives(calib_dir, mel_sess, emb_sess, mel_input_name, emb_input_name,
                          mel_frames_per_chunk, predict_fn) -> np.ndarray:
    """Score every negative window in a directory of real WAVs (e.g. MS-SNSD) through
    the trained detector, for real-audio threshold calibration (see --calib-dir).
    `predict_fn(X: np.ndarray[N,1536]) -> np.ndarray[N]` handles normalization and
    inference (the DNN normalizes internally — see WakeWordDNN — so no separate
    scaler is needed here). Returns a flat array of positive-class probabilities,
    one per sliding window."""
    from pathlib import Path as _P
    files = sorted(_P(calib_dir).glob("*.wav"))
    scored = []
    for f in files:
        try:
            audio = load_audio(str(f))
            embs, rms = extract_embeddings(audio, mel_sess, emb_sess, mel_input_name, emb_input_name, mel_frames_per_chunk)
            X, _y = windows_from_embeddings(embs, rms, positive=False)
            if not X:
                continue
            scored.append(predict_fn(np.array(X, dtype=np.float32)))
        except Exception as e:
            progress(f"  calib skip {f.name}: {e}")
    return np.concatenate(scored) if scored else np.empty((0,), np.float32)


def pick_operating_threshold(pos: np.ndarray, neg: np.ndarray, neg_hours: float,
                             target_faph: float, recall_floor: float,
                             tmin: float = 0.30, tmax: float = 0.90):
    """Choose a fire threshold that PRESERVES recall, then minimizes false accepts.

    The previous formula — max(neg_p95 + 0.10, (neg_p95 + pos_p10)/2), clamped to
    [0.3, 0.85] — floored at 0.30 whenever the model had clean separation
    (negatives clustered near 0), leaving a strictly-better operating point on the
    table: e.g. a model measuring 17.7 FA/hr at the floored 0.30 held 100% recall
    all the way up to 0.52, where it measured only 10.6 FA/hr. This instead sweeps
    thresholds and picks lexicographically: (1) find the best achievable recall,
    (2) keep recall within a small tolerance of it (never below `recall_floor`),
    (3) among those, take the HIGHEST threshold — i.e. the lowest FA. If some
    recall-preserving threshold also meets the FA target, prefer that subset.
    Recall is measured on held-out (group-split) positives, so the operating
    point transfers to genuinely unseen voices. Returns (threshold, faph, recall)."""
    if len(pos) == 0 or len(neg) == 0:
        return 0.5, 0.0, 0.0
    cands = np.round(np.arange(tmin, tmax + 1e-9, 0.01), 2)
    recalls = np.array([float(np.mean(pos >= t)) for t in cands])
    faphs = np.array([(float(np.sum(neg >= t)) / neg_hours if neg_hours > 0 else 0.0) for t in cands])
    best_recall = float(recalls.max())
    # "Acceptable" recall: within 2 points of the best achievable, and — when the
    # model can actually clear the floor — no lower than the floor. When the floor
    # is UNachievable (best_recall < recall_floor), we must NOT demand it: doing so
    # would leave `feasible` empty and (a prior bug) fall back to every threshold,
    # then pick the highest one (0.90) and annihilate recall. Clamping the target
    # to best_recall guarantees `feasible` always contains the argmax point.
    target = best_recall - 0.02
    if best_recall >= recall_floor:
        target = max(target, recall_floor)
    target = min(target, best_recall)
    feasible = recalls >= target
    within_fa = feasible & (faphs <= target_faph)
    pick_from = within_fa if within_fa.any() else feasible
    idxs = np.where(pick_from)[0]
    best_i = int(idxs[np.argmax(cands[idxs])])  # highest threshold in the chosen set → lowest FA
    return float(cands[best_i]), float(faphs[best_i]), float(recalls[best_i])


# ---------------------------------------------------------------------------
# Runtime event replay for calibration: the correct way to pick a threshold.
# ---------------------------------------------------------------------------

def replay_fires(scores, threshold: float, hysteresis: int,
                 smoothing: int = SCORE_SMOOTHING_FRAMES,
                 refractory_ms: int = REFRACTORY_MS, frame_ms: int = FRAME_MS) -> int:
    """Count detection EVENTS over an ORDERED per-window score stream by replaying
    the exact runtime logic: a trailing `smoothing`-frame moving average, then
    `hysteresis` consecutive smoothed frames at/above `threshold`, then a refractory
    lockout. Byte-for-byte equivalent to wakewordEvalCore.countFires + the loop's own
    smoothing, so a threshold chosen here means the same thing the device does at run
    time. (The previous per-window counting ignored smoothing/hysteresis/refractory
    and over-estimated crossings, which is why shipped 'calibrated' thresholds still
    measured 40-140 FA/hr.)"""
    from collections import deque
    win = deque(maxlen=smoothing)
    fires = 0
    consec = 0
    last_fire = -1e18
    for i, s in enumerate(scores):
        win.append(float(s))
        sm = sum(win) / len(win)
        if sm < threshold:
            consec = 0
            continue
        consec += 1
        if consec < hysteresis:
            continue
        t_ms = i * frame_ms
        if t_ms - last_fire < refractory_ms:
            continue
        last_fire = t_ms
        consec = 0
        fires += 1
    return fires


def score_streams(paths, mel_sess, emb_sess, mel_in, emb_in, mfc, predict_fn,
                  isolate_pad_s: float = 0.0):
    """Return an ordered per-window score stream (np.ndarray) for each WAV in `paths`.
    With isolate_pad_s > 0 each clip is padded with that much leading + trailing
    silence, so an isolated positive utterance is scored exactly as the device hears
    it live (nothing from an adjacent clip bleeding into the 2.2 s rolling window;
    concatenating positives back-to-back understates recall by ~25 points)."""
    from pathlib import Path as _P
    pad = np.zeros(int(isolate_pad_s * SAMPLE_RATE), np.float32) if isolate_pad_s > 0 else None
    streams = []
    for f in paths:
        try:
            audio = load_audio(str(f))
            if pad is not None:
                audio = np.concatenate([pad, audio, pad])
            embs, rms = extract_embeddings(audio, mel_sess, emb_sess, mel_in, emb_in, mfc)
            X, _y = windows_from_embeddings(embs, rms, positive=False)  # ordered windows; labels unused
            if X:
                streams.append(predict_fn(np.array(X, np.float32)))
        except Exception as e:
            progress(f"  stream skip {_P(f).name}: {e}")
    return streams


def sweep_operating_point(pos_streams, neg_streams, neg_hours: float, hysteresis: int,
                          target_faph: float = GATE_TARGET_FAPH,
                          recall_floor: float = GATE_RECALL_FLOOR,
                          tmin: float = 0.10, tmax: float = 0.90, step: float = 0.02):
    """Sweep thresholds and pick an operating point by REPLAYING runtime events on
    isolated-positive and continuous-negative streams. Returns
    (threshold, faph, recall, rows). Selection: among thresholds meeting both the FA
    target and the recall floor, take the highest threshold (lowest FA); if none meet
    both, prefer the FA target subset with the best recall, else the global min-FA
    point. Sweep starts at 0.10 because a real-negative-trained head's best point can
    sit well below the old 0.30/0.40 floors."""
    cands = np.round(np.arange(tmin, tmax + 1e-9, step), 2)
    rows = []
    for t in cands:
        fa = sum(replay_fires(s, float(t), hysteresis) for s in neg_streams)
        faph = (fa / neg_hours) if neg_hours > 0 else 0.0
        rec = (float(np.mean([1.0 if replay_fires(s, float(t), hysteresis) > 0 else 0.0
                              for s in pos_streams])) if pos_streams else 0.0)
        rows.append((float(t), float(faph), float(rec)))
    both = [r for r in rows if r[2] >= recall_floor and r[1] <= target_faph]
    if both:
        best = max(both, key=lambda r: r[0])            # highest threshold → lowest FA
    else:
        under = [r for r in rows if r[1] <= target_faph]
        best = (max(under, key=lambda r: r[2]) if under  # meet FA, best recall
                else min(rows, key=lambda r: r[1]))       # nothing meets FA: least-bad FA
    return best[0], best[1], best[2], rows


# ---------------------------------------------------------------------------
# Audio augmentation — the core of robust wake-word training. Convolving with
# room impulse responses + mixing noise at random SNR + gain jitter teaches the
# model to generalize from clean synthetic TTS to a real, reverberant, noisy
# microphone. Done procedurally (no datasets to download) so training stays fast
# and self-contained, and each base clip becomes many effective training samples.
# ---------------------------------------------------------------------------

def make_rir(sr: int, rng) -> np.ndarray:
    """Procedural room impulse response: direct spike + exponentially-decaying tail.
    Used only when the real MIT impulse-response pack isn't installed."""
    decay = rng.uniform(0.08, 0.35)
    n = max(8, int(sr * rng.uniform(0.10, 0.30)))
    t = np.arange(n) / sr
    rir = (rng.standard_normal(n) * np.exp(-t / decay)).astype(np.float32)
    rir[0] += 1.0  # direct path dominates
    return rir


def load_rir_pool(rir_dir, sr: int, limit: int = 120):
    """Load up to `limit` REAL room impulse responses (MIT survey, 16 kHz) as
    normalized mono float32. Convolving positives with real room acoustics matches
    a reverberant mic far better than the procedural RIR — the approach openWakeWord
    and microWakeWord both take. Returns [] if the pack isn't installed, so the
    caller transparently falls back to make_rir()."""
    from pathlib import Path as _P
    pool = []
    files = sorted(_P(rir_dir).glob("*.wav")) if rir_dir else []
    for f in files[:limit]:
        try:
            rir = load_audio(str(f))  # → mono float32 @ SAMPLE_RATE
            peak = float(np.max(np.abs(rir))) + 1e-9
            if rir.size >= 8:
                pool.append((rir / peak).astype(np.float32))
        except Exception:
            continue
    return pool


def pitch_shift(x: np.ndarray, semitones: float) -> np.ndarray:
    """Length-preserving pitch shift via overlap-add time-scaling + resample.
    Shifts vocal pitch/formants without changing duration, so each clip's clean
    speech→silence boundary (used for completion-aligned labeling) is preserved.
    Mild OLA artifacts are acceptable — they add useful augmentation variety.
    Returns x unchanged if it's too short to frame."""
    from scipy.signal import resample
    rate = 2.0 ** (semitones / 12.0)
    n = len(x)
    win = 1024
    hop_a = win // 4
    hop_s = max(1, int(round(hop_a * rate)))
    if n < win + hop_a or rate == 1.0:
        return x.astype(np.float32)
    window = np.hanning(win).astype(np.float32)
    n_frames = 1 + (n - win) // hop_a
    out_len = win + hop_s * (n_frames - 1)
    out = np.zeros(out_len, dtype=np.float32)
    norm = np.zeros(out_len, dtype=np.float32)
    for i in range(n_frames):
        a = i * hop_a
        s = i * hop_s
        out[s:s + win] += x[a:a + win] * window
        norm[s:s + win] += window
    out = out / np.maximum(norm, 1e-6)
    # Resample the time-scaled signal back to the original length → net pitch shift.
    return resample(out, n).astype(np.float32)


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


def augment(audio: np.ndarray, sr: int, rng, noise_pool, rir_pool=None) -> np.ndarray:
    out = audio.astype(np.float32).copy()
    if rng.random() < 0.3:  # pitch/formant jitter (±3 semitones, length-preserving)
        try:
            out = pitch_shift(out, float(rng.uniform(-3.0, 3.0)))
            if out.shape[0] != audio.shape[0]:  # paranoia: keep frame→label alignment
                out = np.resize(out, audio.shape[0]).astype(np.float32)
        except Exception:
            out = audio.astype(np.float32).copy()
    if rng.random() < 0.6:  # reverb — prefer a REAL room impulse, else procedural
        rir = rir_pool[int(rng.integers(len(rir_pool)))] if rir_pool else make_rir(sr, rng)
        out = np.convolve(out, rir)[: len(audio)].astype(np.float32)
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
    ap.add_argument("--rir-dir", default=None,
                    help="directory of real room-impulse-response WAVs (MIT pack); procedural reverb if absent")
    ap.add_argument("--calib-dir", default=None,
                    help="directory of real negative WAVs (e.g. MS-SNSD) to calibrate the fire threshold against, "
                         "instead of the synthetic held-out split")
    args = ap.parse_args()

    global _EMBEDDER, _EMBEDDER_POOL
    if args.embed_runtime == "ortweb":
        script = args.embed_script
        if not script:
            from pathlib import Path as _P
            script = str(_P(__file__).with_name("wake_embed_ortweb.mjs"))
        progress(f"Starting {EMBED_POOL_SIZE} onnxruntime-web embedding servers (browser parity, parallel)…")
        try:
            _EMBEDDER_POOL = EmbedderPool(args.node_bin, script, args.mel, args.embed, EMBED_POOL_SIZE)
            _EMBEDDER = _EMBEDDER_POOL._all[0]  # single-instance fallback for sequential call sites (e.g. --calib-dir scoring)
            # Ensure every Node embed server is reaped on every exit path, including the
            # sys.exit() early-returns below — not just the explicit close() at the end.
            atexit.register(_EMBEDDER_POOL.close)
        except Exception as e:
            progress(f"ERROR: could not start ort-web embed server pool: {e}", error=True)
            sys.exit(1)
        # The precomputed negative bank lives in NATIVE embedding space; mixing it
        # with ort-web positives would let the model separate by feature-space
        # instead of by phrase. Drop it in ort-web mode for a coherent space.
        if args.neg_features and not args.keep_native_bank:
            progress("Skipping native negative-feature bank in ortweb mode (space mismatch)")
            args.neg_features = None

    import onnxruntime as ort
    from pathlib import Path
    import torch
    import torch.nn as nn
    import torch.optim as optim

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
    rir_pool = load_rir_pool(args.rir_dir, SAMPLE_RATE)
    progress(f"Reverb augmentation: {len(rir_pool)} real room impulses"
             if rir_pool else "Reverb augmentation: procedural (real RIR pack not installed)")
    AUG_POS, AUG_NEG = 12, 12

    lead_pad = np.zeros(int(0.6 * SAMPLE_RATE), dtype=np.float32)   # 0.6 s lead-in
    tail_pad = np.zeros(int(0.3 * SAMPLE_RATE), dtype=np.float32)   # 0.3 s trailing

    def process_one(f, label, rng, embedder):
        base = load_audio(str(f))
        # Pad positives with leading/trailing silence so the phrase has a
        # clean speech→silence boundary for completion-aligned labeling.
        if label == 1:
            base = np.concatenate([lead_pad, base, tail_pad])
        n_aug = AUG_POS if label == 1 else AUG_NEG
        # Labels come from the CLEAN clip's RMS: augment() mixes noise into
        # every frame, which would erase the silence boundary and break
        # completion detection. Augmentation preserves length, so the clean
        # frame→window alignment is valid for every variant.
        _, clean_rms = extract_embeddings(base, mel_sess, emb_sess, mel_input_name, emb_input_name, mel_frames_per_chunk, embedder)
        variants = [base] + [augment(base, SAMPLE_RATE, rng, noise_pool, rir_pool) for _ in range(n_aug)]
        wx_all, wy_all = [], []
        for v in variants:
            embs, rms = extract_embeddings(v, mel_sess, emb_sess, mel_input_name, emb_input_name, mel_frames_per_chunk, embedder)
            wx, wy = windows_from_embeddings(embs, clean_rms if label == 1 else rms, positive=(label == 1))
            wx_all.extend(wx); wy_all.extend(wy)
        return wx_all, wy_all

    def group_id(f) -> str:
        # Strip the trailing numeric index (speed variant for positives, phrase
        # index for negatives) so windows group by VOICE, not by voice+speed —
        # e.g. pos_af_bella_00.wav and pos_af_bella_05.wav (same voice, different
        # speed) collapse to one group. Without this, holding out a "group" could
        # still hold out only one speed of a voice while the model saw that same
        # voice's timbre at other speeds in training — a softer leak than a random
        # per-window split, but still not a genuinely unseen voice.
        return re.sub(r"_\d+$", "", f.stem)

    def collect(dir_path: str, label: int, name: str):
        files = sorted(Path(dir_path).glob("*.wav"))
        n_aug = AUG_POS if label == 1 else AUG_NEG
        X, y, groups = [], [], []
        done = 0

        if _EMBEDDER_POOL is not None:
            # Parallel across files — each task gets its own pooled embedder
            # subprocess (single-threaded WASM, bit-identical to the browser) and
            # its own independent RNG (numpy Generators aren't thread-safe to
            # share; [1234, i] deterministically derives an uncorrelated stream
            # per file index instead of racing on the shared aug_rng).
            progress(f"Processing {len(files)} {name} files (×{n_aug + 1} augmented, {EMBED_POOL_SIZE}-way parallel)…", count=len(files))

            def task(item):
                i, f = item
                embedder = _EMBEDDER_POOL.acquire()
                try:
                    rng = np.random.default_rng([1234, i])
                    return f, process_one(f, label, rng, embedder), None
                except Exception as e:
                    return f, None, e
                finally:
                    _EMBEDDER_POOL.release(embedder)

            with ThreadPoolExecutor(max_workers=EMBED_POOL_SIZE) as ex:
                for f, result, err in ex.map(task, enumerate(files)):
                    done += 1
                    if err is not None:
                        progress(f"  skip {f.name}: {err}")
                    else:
                        wx, wy = result
                        X.extend(wx); y.extend(wy)
                        groups.extend([group_id(f)] * len(wx))
                    if done % 10 == 0 or done == len(files):
                        progress(f"  {done}/{len(files)} done")
        else:
            progress(f"Processing {len(files)} {name} files (×{n_aug + 1} augmented)…", count=len(files))
            for i, f in enumerate(files):
                try:
                    wx, wy = process_one(f, label, aug_rng, None)
                    X.extend(wx); y.extend(wy)
                    groups.extend([group_id(f)] * len(wx))
                except Exception as e:
                    progress(f"  skip {f.name}: {e}")
                if (i + 1) % 10 == 0:
                    progress(f"  {i + 1}/{len(files)} done")

        return X, y, groups

    Xp, yp, gp = collect(args.positives, 1, "positive")
    Xn, yn, gn = collect(args.negatives, 0, "negative")

    if not Xp or not Xn:
        progress("ERROR: need both positive and negative samples", error=True)
        sys.exit(1)

    X = np.array(Xp + Xn, dtype=np.float32)
    y = np.array(yp + yn, dtype=np.int32)
    # Group id per window — the SOURCE FILE (voice+speed for positives, phrase+
    # voice for negatives). Used for a group-held-out validation split below:
    # a random PER-WINDOW split leaks speaker identity (windows from the same
    # voice are highly correlated), which is what made earlier validation
    # numbers here look far better than the model's actual generalization to
    # unseen voices (measured separately by eval:wakeword's independent voice
    # bank) — see project notes. Holding out entire source files fixes that.
    groups = np.array(gp + gn, dtype=object)

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
                # Each precomputed-bank window is independent audio (random slices
                # of an unrelated 2000h corpus) — no speaker-correlation risk, so a
                # unique group per row is fine (never forced together across a
                # train/val split, but also never NEEDS to be).
                bank_groups = np.array([f"negbank_{i}" for i in range(len(bank))], dtype=object)
                groups = np.concatenate([groups, bank_groups])
                progress(f"Added {len(bank)} negatives from the feature bank")
            else:
                progress(f"Feature bank width {bank.shape[1]} != {X.shape[1]} — skipped")
        except Exception as e:
            progress(f"Feature bank skipped ({e})")

    # Cap negatives to a multiple of positives. Negative VOLUME is the single
    # biggest lever for a low false-accept rate (openWakeWord trains on ~30k h of
    # negatives; microWakeWord weights the negative class 20×), so we keep this
    # ratio high. The floor on the other side: left fully uncapped, balance() would
    # duplicate each completion-aligned positive so many times the phrase signal
    # drowns and the detector collapses. 25:1 keeps a strong, boundary-tightening
    # negative set while the oversampled positives still shape the decision surface.
    NEG_PER_POS = 40
    rng_cap = np.random.default_rng(11)
    pos_i = np.where(y == 1)[0]; neg_i = np.where(y == 0)[0]
    if len(pos_i) and len(neg_i) > NEG_PER_POS * len(pos_i):
        neg_keep = rng_cap.choice(neg_i, NEG_PER_POS * len(pos_i), replace=False)
        keep = np.concatenate([pos_i, neg_keep]); rng_cap.shuffle(keep)
        X = X[keep]; y = y[keep]; groups = groups[keep]
        progress(f"Capped negatives to {NEG_PER_POS}:1 ({len(neg_keep)} kept)")

    n_pos = int(np.sum(y == 1)); n_neg = int(np.sum(y == 0))
    progress(f"Training on {n_pos} positive + {n_neg} negative windows…")
    if n_pos == 0 or n_neg == 0:
        progress("ERROR: after silence filtering, need both positive and negative windows", error=True)
        sys.exit(1)

    # ---------------------------------------------------------------------
    # Model + training loop — openWakeWord's own auto_train recipe: hard-example
    # loss masking, a linearly-ramping negative-class weight, Adam with warmup+
    # cosine-decay LR, and checkpoint averaging (SWA-style). A one-shot sklearn
    # MLPClassifier.fit() (the previous approach here) cannot do any of these —
    # they all require control over individual training steps. Scaled down from
    # openWakeWord's production values (50000 steps against ~2000h of data) to
    # fit our much smaller per-phrase dataset.
    # ---------------------------------------------------------------------

    class FCNBlock(nn.Module):
        def __init__(self, dim: int):
            super().__init__()
            self.linear = nn.Linear(dim, dim)
            self.norm = nn.LayerNorm(dim)
            self.relu = nn.ReLU()

        def forward(self, x):
            return self.relu(self.norm(self.linear(x)))

    class WakeWordDNN(nn.Module):
        """Linear->ReLU->LayerNorm input block, N FCNBlocks, Sigmoid output —
        matches openWakeWord's reference DNN architecture. Normalization is a
        fixed (non-trainable) buffer INSIDE the graph, computed once from the
        training split, so the exported ONNX needs no separate scaler node and
        the whole forward pass traces cleanly for torch.onnx.export."""
        def __init__(self, input_dim: int, layer_dim: int = 128, n_blocks: int = 1):
            super().__init__()
            self.register_buffer("mean", torch.zeros(input_dim))
            self.register_buffer("std", torch.ones(input_dim))
            self.flatten = nn.Flatten()
            self.layer1 = nn.Linear(input_dim, layer_dim)
            self.relu1 = nn.ReLU()
            self.norm1 = nn.LayerNorm(layer_dim)
            self.blocks = nn.ModuleList([FCNBlock(layer_dim) for _ in range(n_blocks)])
            self.out = nn.Linear(layer_dim, 1)
            self.sigmoid = nn.Sigmoid()

        def forward(self, x):
            x = self.flatten(x)
            x = (x - self.mean) / self.std
            x = self.norm1(self.relu1(self.layer1(x)))
            for block in self.blocks:
                x = block(x)
            return self.sigmoid(self.out(x))

    def torch_predict(model, Xin: np.ndarray, batch: int = 4096) -> np.ndarray:
        model.eval()
        out = []
        with torch.no_grad():
            for i in range(0, len(Xin), batch):
                chunk = torch.tensor(Xin[i:i + batch], dtype=torch.float32)
                out.append(model(chunk).squeeze(1).numpy())
        return np.concatenate(out) if out else np.empty((0,), np.float32)

    def group_train_val_split(y_in: np.ndarray, groups_in: np.ndarray, val_frac: float, rng_t):
        """Held out by GROUP (source file — one voice+speed for positives, one
        phrase+voice for negatives), not by window. A random per-window split
        leaks speaker identity: windows from the same TTS clip are highly
        correlated, so the model can partly memorize a voice's acoustic
        fingerprint and still "generalize" to held-out windows FROM THAT SAME
        VOICE. That's what made earlier validation numbers here look far
        better (90%+ recall) than the model's actual recall on eval:wakeword's
        genuinely independent voice bank (as low as 17%). Holding out whole
        source files/voices fixes that — validation now measures the same
        thing eval:wakeword does: does this generalize to voices never seen?
        Split per class so both train and val get positives and negatives."""
        train_mask = np.zeros(len(y_in), dtype=bool)
        val_mask = np.zeros(len(y_in), dtype=bool)
        for cls in (0, 1):
            cls_idx = np.where(y_in == cls)[0]
            cls_groups = np.unique(groups_in[cls_idx])
            rng_t.shuffle(cls_groups)
            n_val = max(1, int(len(cls_groups) * val_frac))
            val_groups = set(cls_groups[:n_val].tolist())
            for i in cls_idx:
                if groups_in[i] in val_groups:
                    val_mask[i] = True
                else:
                    train_mask[i] = True
        return train_mask, val_mask

    def train_dnn(X_in: np.ndarray, y_in: np.ndarray, groups_in: np.ndarray, layer_dim: int = 128, n_blocks: int = 2,
                  total_steps: int = 6000, batch_pos: int = 32, batch_neg: int = 224,
                  max_negative_weight: float = 25.0, target_lr: float = 1e-4, seed: int = 42):
        rng_t = np.random.default_rng(seed)
        torch.manual_seed(seed)

        # 0.25 (up from 0.15): with only ~28 positive source voices total, a 15%
        # hold-out was just 4 voices — a noisy validation estimate where one
        # unusually hard voice could swing recall by 25 points. More held-out
        # voices gives a steadier signal to base checkpoint selection on.
        train_mask, val_mask = group_train_val_split(y_in, groups_in, val_frac=0.25, rng_t=rng_t)
        Xtr, ytr = X_in[train_mask], y_in[train_mask]
        Xva, yva = X_in[val_mask], y_in[val_mask]
        pos_tr = Xtr[ytr == 1]; neg_tr = Xtr[ytr == 0]
        if len(pos_tr) == 0 or len(neg_tr) == 0:
            raise ValueError("need both positive and negative training windows")
        n_pos_val_groups = len(np.unique(groups_in[val_mask & (y_in == 1)]))
        progress(f"  group-held-out split: {len(Xtr)} train / {len(Xva)} val windows "
                 f"({n_pos_val_groups} positive source voices held out entirely for validation)")

        model = WakeWordDNN(input_dim=X_in.shape[1], layer_dim=layer_dim, n_blocks=n_blocks)
        # Normalization stats from the TRAIN split only — computing them over all
        # of X (as the old scaler.fit_transform(X) did, before the val split)
        # leaks validation statistics into training; this fixes that too.
        mean = Xtr.mean(axis=0); std = Xtr.std(axis=0); std[std < 1e-6] = 1e-6
        with torch.no_grad():
            model.mean.copy_(torch.tensor(mean, dtype=torch.float32))
            model.std.copy_(torch.tensor(std, dtype=torch.float32))

        optimizer = optim.Adam(model.parameters(), lr=target_lr)
        warmup_steps = max(1, total_steps // 5)
        hold_steps = total_steps // 3

        def lr_at(step: int) -> float:
            if step < warmup_steps:
                return target_lr * (step / warmup_steps)
            frac = (step - warmup_steps - hold_steps) / max(1, total_steps - warmup_steps - hold_steps)
            frac = min(1.0, max(0.0, frac))
            return 0.5 * target_lr * (1 + float(np.cos(np.pi * frac)))

        neg_weight_schedule = np.linspace(1.0, max_negative_weight, total_steps)
        Xva_t = torch.tensor(Xva, dtype=torch.float32)

        # Feature-space augmentation on each TRAINING batch (never validation) —
        # label-preserving regularizers that target the measured weakness, recall
        # on voices never seen in training. Two techniques adapted to our 16×96
        # embedding windows (we can't SpecAugment raw spectrograms — the detector
        # only sees embeddings — but both transfer):
        #   • within-class MixUp: blend a window with another of the SAME class,
        #     λ∈[0.5,1] so the original dominates and the hard label stays valid.
        #     Blending two different positive VOICES synthesizes an intermediate
        #     voice — literally augmenting toward unseen-voice generalization.
        #     (Cross-class mixup is skipped: its soft labels would break the
        #     hard-example mask + negative-weight scheme below.)
        #   • SpecAugment time-masking: zero a random 1–2 frame span of the
        #     16-frame window so the detector can't lean on any single frame.
        P_MIX, P_MASK = 0.4, 0.4
        def augment_batch(xb, n_pos):
            out = xb.copy()
            for i in range(out.shape[0]):
                if rng_t.random() < P_MIX:
                    # same-class partner — batch is [positives | negatives], so the
                    # class of row i is known from its position (no label scan).
                    j = int(rng_t.integers(0, n_pos)) if i < n_pos else int(rng_t.integers(n_pos, out.shape[0]))
                    lam = rng_t.uniform(0.5, 1.0)
                    out[i] = lam * out[i] + (1.0 - lam) * xb[j]
                if rng_t.random() < P_MASK:
                    w = out[i].reshape(DET_FRAMES, EMB_DIM).copy()
                    span = int(rng_t.integers(1, 3))  # mask 1 or 2 frames
                    start = int(rng_t.integers(0, DET_FRAMES - span + 1))
                    w[start:start + span, :] = 0.0
                    out[i] = w.reshape(-1)
            return out

        val_fp_history, val_recall_history = [], []
        best_checkpoints = []
        MAX_CHECKPOINTS = 10
        VAL_EVERY = max(1, total_steps // 40)

        for step in range(total_steps):
            for g in optimizer.param_groups:
                g["lr"] = lr_at(step)

            pi = rng_t.choice(len(pos_tr), batch_pos, replace=True)
            ni = rng_t.choice(len(neg_tr), batch_neg, replace=True)
            xb = np.concatenate([pos_tr[pi], neg_tr[ni]], axis=0)
            xb = augment_batch(xb, batch_pos)
            yb = np.concatenate([np.ones(batch_pos, np.float32), np.zeros(batch_neg, np.float32)])
            wb = np.concatenate([np.ones(batch_pos, np.float32),
                                  np.full(batch_neg, neg_weight_schedule[step], np.float32)])
            xb_t = torch.tensor(xb, dtype=torch.float32)
            yb_t = torch.tensor(yb, dtype=torch.float32).unsqueeze(1)
            wb_t = torch.tensor(wb, dtype=torch.float32).unsqueeze(1)

            model.train()
            optimizer.zero_grad()
            preds = model(xb_t)

            # Hard-example mining: only backprop on borderline predictions (neg
            # preds >=0.001, pos preds <0.999) — openWakeWord's auto_train does
            # the same to concentrate gradient updates on cases the model hasn't
            # already nailed. Falls back to the full batch if everything's
            # currently "easy" (common in the first few steps).
            with torch.no_grad():
                mask = ((yb_t == 0) & (preds >= 0.001)) | ((yb_t == 1) & (preds < 0.999))
            if mask.sum() == 0:
                mask = torch.ones_like(mask, dtype=torch.bool)

            loss_raw = nn.functional.binary_cross_entropy(preds, yb_t, weight=wb_t, reduction="none")
            loss = (loss_raw * mask.float()).sum() / mask.float().sum().clamp(min=1)
            loss.backward()
            optimizer.step()

            if (step + 1) % VAL_EVERY == 0 or step == total_steps - 1:
                model.eval()
                with torch.no_grad():
                    val_probs = model(Xva_t).squeeze(1).numpy()
                n_fp = int(np.sum((val_probs >= 0.5) & (yva == 0)))
                recall = float(np.mean(val_probs[yva == 1] >= 0.5)) if np.any(yva == 1) else 0.0
                val_fp_history.append(n_fp)
                val_recall_history.append(recall)

                # Checkpoint selection: keep this snapshot when it's at or below
                # the median FP count seen so far AND at or above the MEDIAN
                # recall. openWakeWord's auto_train uses a 5th-percentile recall
                # floor (theirs runs against ~2000h of negatives, where FP
                # dominates); on our smaller dataset that let the FP criterion
                # win almost every time and dragged recall down (measured: a
                # first pass at 5th-percentile shipped a checkpoint at 83%
                # recall vs the prior model's 100%). Requiring above-median
                # recall too balances both metrics instead of letting FP alone
                # decide which snapshots get averaged (below, approximating SWA).
                if len(val_fp_history) >= 3:
                    fp_thr = np.percentile(val_fp_history, 50)
                    recall_thr = np.percentile(val_recall_history, 50)
                    if n_fp <= fp_thr and recall >= recall_thr:
                        # Score combines both metrics (recall dominant, FP a
                        # tiebreaker) so eviction below removes the WORST
                        # qualifying checkpoint, not just the oldest — a plain
                        # FIFO pop(0) could discard a genuinely strong early
                        # checkpoint in favor of a later one that only barely
                        # cleared the bar, since both FP and recall are noisy
                        # (non-monotonic) across steps.
                        score = recall - 0.001 * n_fp
                        best_checkpoints.append((score, {k: v.clone() for k, v in model.state_dict().items()}))
                        if len(best_checkpoints) > MAX_CHECKPOINTS:
                            best_checkpoints.sort(key=lambda ck: ck[0])
                            best_checkpoints.pop(0)

                if (step + 1) % (VAL_EVERY * 5) == 0:
                    progress(f"  step {step + 1}/{total_steps}: val_fp={n_fp} val_recall={recall:.0%} "
                             f"lr={lr_at(step):.2e} neg_w={neg_weight_schedule[step]:.1f} "
                             f"checkpoints={len(best_checkpoints)}")

        if best_checkpoints:
            avg_state = {}
            for k in best_checkpoints[0][1]:
                avg_state[k] = torch.stack([ck[1][k].float() for ck in best_checkpoints]).mean(dim=0)
            model.load_state_dict(avg_state)
            progress(f"Averaged {len(best_checkpoints)} checkpoints (SWA-style)")

        model.eval()
        with torch.no_grad():
            val_probs = model(Xva_t).squeeze(1).numpy()
            train_probs = model(torch.tensor(Xtr, dtype=torch.float32)).squeeze(1).numpy()
        val_acc_out = float(np.mean((val_probs >= 0.5) == (yva == 1)))
        train_acc_out = float(np.mean((train_probs >= 0.5) == (ytr == 1)))
        return model, val_probs, yva, val_acc_out, train_acc_out

    DNN_STEPS = 6000
    progress(f"Training DNN ({DNN_STEPS} steps: hard-example mining, negative-weight ramp, "
             f"cosine LR, checkpoint averaging)…")
    model, pva, yva, val_acc, acc = train_dnn(X, y, groups, total_steps=DNN_STEPS)
    progress(f"Training accuracy: {acc:.1%}")

    # ── Threshold calibration by RUNTIME EVENT REPLAY (not per-window counting) ──
    # Score isolated positive clips and continuous real-negative audio as ordered
    # streams, then replay the exact device fire logic (4-frame smoothing + N-frame
    # hysteresis + 1 s refractory) across a 0.10-0.90 sweep, per hardware surface.
    # This is what the eval harness does, so a threshold chosen here means the same
    # thing at run time, unlike the old per-window count, which understated FA and
    # picked thresholds that still measured 40-140 FA/hr live.
    from pathlib import Path as _P
    predict_fn = lambda Xin: torch_predict(model, Xin)
    threshold = 0.5
    pod_threshold = 0.5
    gate_pass = None           # None = could not certify (no real negatives); bool otherwise
    gate_reason = "no real-negative audio (--calib-dir): cannot certify FA/hr"

    try:
        # Positives scored in ISOLATION (0.6 s silence pad each): the way a real
        # wake utterance is heard, so recall isn't understated by clip-to-clip bleed.
        pos_paths = sorted(_P(args.positives).glob("*.wav"))
        pos_streams = score_streams(pos_paths, mel_sess, emb_sess, mel_input_name,
                                    emb_input_name, mel_frames_per_chunk, predict_fn,
                                    isolate_pad_s=0.6)

        # Negatives: prefer HELD-OUT real audio (the true FP source). Each file is a
        # continuous stream so refractory/hysteresis behave as they do live.
        neg_streams = []
        if args.calib_dir:
            neg_paths = sorted(_P(args.calib_dir).glob("*.wav"))
            progress(f"Calibrating by event-replay over {len(pos_paths)} positive clips "
                     f"+ {len(neg_paths)} real-negative files…")
            neg_streams = score_streams(neg_paths, mel_sess, emb_sess, mel_input_name,
                                        emb_input_name, mel_frames_per_chunk, predict_fn,
                                        isolate_pad_s=0.0)
        neg_windows = int(sum(len(s) for s in neg_streams))
        neg_hours = neg_windows / 12.5 / 3600.0

        if pos_streams and neg_streams and neg_hours > 0:
            b_th, b_fa, b_rec, _rows = sweep_operating_point(pos_streams, neg_streams, neg_hours, HYST_BROWSER)
            p_th, p_fa, p_rec, _prows = sweep_operating_point(pos_streams, neg_streams, neg_hours, HYST_POD)
            threshold, pod_threshold = b_th, p_th
            gate_pass = bool(b_fa <= GATE_TARGET_FAPH and b_rec >= GATE_RECALL_FLOOR)
            gate_reason = (
                f"browser th {b_th:.2f}: {b_fa:.2f} FA/hr, recall {b_rec:.0%} over {neg_hours * 60:.0f} min real audio"
                if gate_pass else
                f"no browser threshold meets ≤{GATE_TARGET_FAPH:.0f} FA/hr with recall ≥{GATE_RECALL_FLOOR:.0%} "
                f"(best: th {b_th:.2f} → {b_fa:.2f} FA/hr, recall {b_rec:.0%})")
            progress(f"Validation accuracy: {val_acc:.1%}; "
                     f"browser th {b_th:.2f} ({b_fa:.2f} FA/hr, recall {b_rec:.0%}), "
                     f"pod th {p_th:.2f} ({p_fa:.2f} FA/hr, recall {p_rec:.0%}); "
                     f"gate {'PASS' if gate_pass else 'FAIL'}: {gate_reason}")
        else:
            # No real negatives available: fall back to the old synthetic per-window
            # estimate just to have SOME threshold, but leave gate_pass=None so the
            # caller knows this model was never certified against real audio.
            pos_w = pva[yva == 1]; neg_w = pva[yva == 0]
            if len(pos_w) and len(neg_w):
                hours = len(neg_w) / 12.5 / 3600.0
                threshold, measured, recall = pick_operating_threshold(pos_w, neg_w, hours, GATE_TARGET_FAPH, 0.6)
                pod_threshold = threshold
            progress(f"Validation accuracy: {val_acc:.1%}; threshold {threshold:.2f} "
                     f"(synthetic-only estimate: {gate_reason})")
    except Exception as e:
        progress(f"Threshold calibration failed ({e}); using {threshold:.2f}, gate uncertified")

    progress("Exporting ONNX detector…")
    dummy = torch.zeros(1, DET_FRAMES, EMB_DIM, dtype=torch.float32)
    model.eval()
    # dynamo=False forces the legacy TorchScript-based exporter — the newer
    # dynamo exporter (torch's default in recent versions) emits IR version 10,
    # which the bundled onnxruntime-web WASM build can't load ("Can't create a
    # session", empty error). Our known-working mel/embedding backbones are IR
    # version 7; the old sklearn export pinned IR version 8 for the same reason.
    # Force it down post-export too as a belt-and-suspenders fix regardless of
    # which exporter path ends up handling this on a given torch version.
    torch.onnx.export(model, dummy, args.output, input_names=["x.1"], output_names=["_output"],
                       opset_version=17, dynamo=False)
    import onnx as _onnx
    _exported = _onnx.load(args.output)
    _exported.ir_version = 8
    _onnx.save(_exported, args.output)
    if _EMBEDDER_POOL is not None:
        _EMBEDDER_POOL.close()
    progress("Done.", done=True, threshold=threshold, pod_threshold=pod_threshold,
             accuracy=val_acc, gate_pass=gate_pass, gate_reason=gate_reason)


if __name__ == "__main__":
    main()
