#!/usr/bin/env python3
"""Music analysis for the Studio: tempo + beat grid, musical key, and a beat-synced
chord progression. Emits a single JSON manifest to stdout.

Runs under the data/stem-audio-venv interpreter (see pyenv.ts). Uses Essentia
(AGPL-3.0) exclusively through this subprocess boundary — never imported into app code.

Manifest shape (all times in seconds):
  {
    "durationSec": float,
    "tempo":  {"bpm": float, "confidence": float},
    "key":    {"tonic": "G", "scale": "major", "label": "G major", "strength": float},
    "beats":  [{"time": float, "downbeat": bool}, ...],
    "chords": [{"startTime": float, "endTime": float, "label": "G"}, ...]
  }

Usage: python analyze.py INPUT_AUDIO
Exits non-zero with a message on stderr if analysis fails.
"""
import json
import sys

try:
    import numpy as np
    import essentia.standard as es
except Exception as exc:  # pragma: no cover - import guard
    sys.stderr.write("essentia/numpy import failed: %s\n" % exc)
    sys.exit(2)

SR = 44100


def pitch_class_to_name(pc):
    names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    try:
        return names[int(pc) % 12]
    except Exception:
        return str(pc)


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("usage: analyze.py INPUT_AUDIO\n")
        sys.exit(1)
    path = sys.argv[1]

    audio = es.MonoLoader(filename=path, sampleRate=SR)()
    duration = float(len(audio)) / SR

    # ── tempo + beat grid ─────────────────────────────────────────────────────
    bpm, beat_times, beat_conf, _, _ = es.RhythmExtractor2013(method="multifeature")(audio)
    beat_times = [float(t) for t in beat_times]

    # ── downbeats (bar "1") ───────────────────────────────────────────────────
    # RhythmExtractor2013 gives beats but no bar structure. BeatsLoudness +
    # Meter isn't reliable across genres, so approximate a 4/4 grid: every 4th
    # beat is a downbeat, phase-anchored to the first beat. Good enough for the
    # metronome accent; a future beat-this upgrade can supply true downbeats.
    downbeat_idx = set(range(0, len(beat_times), 4))
    beats = [{"time": t, "downbeat": (i in downbeat_idx)} for i, t in enumerate(beat_times)]

    # ── key ───────────────────────────────────────────────────────────────────
    key, scale, key_strength = es.KeyExtractor()(audio)

    # ── chords (beat-synced) ──────────────────────────────────────────────────
    chords_spans = []
    try:
        window = es.Windowing(type="blackmanharris62")
        spectrum = es.Spectrum()
        speaks = es.SpectralPeaks(orderBy="magnitude", magnitudeThreshold=0.00001,
                                  minFrequency=20, maxFrequency=3500, maxPeaks=60)
        hpcp = es.HPCP()
        frame_size, hop_size = 4096, 2048
        pool = []
        for frame in es.FrameGenerator(audio, frameSize=frame_size, hopSize=hop_size,
                                       startFromZero=True):
            freqs, mags = speaks(spectrum(window(frame)))
            pool.append(hpcp(freqs, mags))
        hpcps = np.array(pool, dtype="float32")

        # ChordsDetectionBeats wants the beat positions in SECONDS (it converts to frames
        # internally via hopSize/sampleRate). Passing frame indices made it read everything
        # past the first few beats as out-of-range, so only ~4 chords came back.
        ticks = np.array([float(t) for t in beat_times], dtype="float32")
        chords, _strengths = es.ChordsDetectionBeats(hopSize=hop_size, sampleRate=SR)(hpcps, ticks)

        # Merge consecutive identical chord labels into spans.
        cur = None
        for i, label in enumerate(chords):
            start = beat_times[i] if i < len(beat_times) else duration
            end = beat_times[i + 1] if (i + 1) < len(beat_times) else duration
            label = str(label)
            if cur and cur["label"] == label:
                cur["endTime"] = end
            else:
                cur = {"startTime": start, "endTime": end, "label": label}
                chords_spans.append(cur)
    except Exception as exc:  # chords are best-effort; tempo/key still return
        sys.stderr.write("chord detection skipped: %s\n" % exc)

    manifest = {
        "durationSec": round(duration, 3),
        "tempo": {"bpm": round(float(bpm), 2), "confidence": round(float(beat_conf), 3)},
        "key": {
            "tonic": key,
            "scale": scale,
            "label": "%s %s" % (key, scale),
            "strength": round(float(key_strength), 3),
        },
        "beats": beats,
        "chords": chords_spans,
    }
    json.dump(manifest, sys.stdout)
    sys.stdout.flush()


if __name__ == "__main__":
    main()
