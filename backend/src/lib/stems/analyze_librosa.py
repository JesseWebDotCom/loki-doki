#!/usr/bin/env python3
"""Windows fallback for analyze.py: tempo + beat grid, musical key, and a beat-synced
chord progression via librosa (essentia publishes no Windows wheels). Emits the SAME
JSON manifest as analyze.py so the app can treat both backends identically.

Method parity notes vs the essentia build:
  - tempo/beats: librosa.beat.beat_track (dynamic-programming beat tracker). librosa
    reports no confidence, so we derive one from beat-interval regularity.
  - key: Krumhansl-Schmuckler correlation of the mean chroma against the 24 rotated
    major/minor profiles (the same idea behind essentia's KeyExtractor).
  - chords: per-beat mean chroma correlated against 24 maj/min triad templates —
    the same template family essentia's ChordsDetectionBeats uses over HPCP.
    Labels match essentia's style: "C", "C#", "Cm", "C#m".

The caller (analyzeJob.ts) transcodes the input to mono 44.1 kHz WAV first, so this
script never needs audioread/ffmpeg for exotic containers.

Usage: python analyze_librosa.py INPUT_AUDIO
Exits non-zero with a message on stderr if analysis fails.
"""
import json
import sys

try:
    import numpy as np
    import librosa
except Exception as exc:  # pragma: no cover - import guard
    sys.stderr.write("librosa/numpy import failed: %s\n" % exc)
    sys.exit(2)

SR = 44100
HOP = 2048

PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Krumhansl-Kessler key profiles.
KS_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KS_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

# Binary triad templates (root position, pitch-class space).
MAJ_TRIAD = np.array([1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0], dtype=float)
MIN_TRIAD = np.array([1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0], dtype=float)


def estimate_key(mean_chroma):
    best = (None, None, -2.0)
    for tonic in range(12):
        rolled = np.roll(mean_chroma, -tonic)
        for scale, profile in (("major", KS_MAJOR), ("minor", KS_MINOR)):
            r = float(np.corrcoef(rolled, profile)[0, 1])
            if r > best[2]:
                best = (tonic, scale, r)
    tonic, scale, r = best
    return PITCH_NAMES[tonic], scale, max(0.0, r)


def chord_for(chroma_seg):
    """Best maj/min triad label for an averaged chroma vector, or None when flat."""
    v = np.asarray(chroma_seg, dtype=float)
    if float(v.max()) <= 1e-6:
        return None
    v = v / (np.linalg.norm(v) + 1e-9)
    best_label, best_score = None, -1.0
    for root in range(12):
        for suffix, template in (("", MAJ_TRIAD), ("m", MIN_TRIAD)):
            t = np.roll(template, root)
            t = t / np.linalg.norm(t)
            score = float(np.dot(v, t))
            if score > best_score:
                best_score, best_label = score, PITCH_NAMES[root] + suffix
    return best_label


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("usage: analyze_librosa.py INPUT_AUDIO\n")
        sys.exit(1)
    path = sys.argv[1]

    y, sr = librosa.load(path, sr=SR, mono=True)
    duration = float(len(y)) / SR

    # ── tempo + beat grid ─────────────────────────────────────────────────────
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, hop_length=HOP)
    bpm = float(np.atleast_1d(tempo)[0])
    beat_times = [float(t) for t in librosa.frames_to_time(beat_frames, sr=sr, hop_length=HOP)]

    # Confidence from beat-interval regularity: a steady grid has near-zero
    # interval variance; noisy/rubato tracking spreads it out.
    if len(beat_times) >= 3:
        intervals = np.diff(beat_times)
        conf = float(max(0.0, min(1.0, 1.0 - (np.std(intervals) / (np.mean(intervals) + 1e-9)))))
    else:
        conf = 0.0

    # ── downbeats (bar "1") ───────────────────────────────────────────────────
    # Same 4/4 approximation as the essentia build (see analyze.py).
    downbeat_idx = set(range(0, len(beat_times), 4))
    beats = [{"time": t, "downbeat": (i in downbeat_idx)} for i, t in enumerate(beat_times)]

    # ── key ───────────────────────────────────────────────────────────────────
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=HOP)
    tonic, scale, strength = estimate_key(chroma.mean(axis=1))

    # ── chords (beat-synced) ──────────────────────────────────────────────────
    chords_spans = []
    try:
        frame_times = librosa.frames_to_time(np.arange(chroma.shape[1]), sr=sr, hop_length=HOP)
        cur = None
        for i, start in enumerate(beat_times):
            end = beat_times[i + 1] if (i + 1) < len(beat_times) else duration
            mask = (frame_times >= start) & (frame_times < end)
            if not mask.any():
                continue
            label = chord_for(chroma[:, mask].mean(axis=1))
            if label is None:
                continue
            if cur and cur["label"] == label:
                cur["endTime"] = end
            else:
                cur = {"startTime": start, "endTime": end, "label": label}
                chords_spans.append(cur)
    except Exception as exc:  # chords are best-effort; tempo/key still return
        sys.stderr.write("chord detection skipped: %s\n" % exc)

    manifest = {
        "durationSec": round(duration, 3),
        "tempo": {"bpm": round(bpm, 2), "confidence": round(conf, 3)},
        "key": {
            "tonic": tonic,
            "scale": scale,
            "label": "%s %s" % (tonic, scale),
            "strength": round(strength, 3),
        },
        "beats": beats,
        "chords": chords_spans,
    }
    json.dump(manifest, sys.stdout)
    sys.stdout.flush()


if __name__ == "__main__":
    main()
