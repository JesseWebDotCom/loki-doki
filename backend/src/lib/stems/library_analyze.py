#!/usr/bin/env python3
"""Library-wide music intelligence: a 1280-d sound embedding plus mood/genre scalars
for one track. Emits a single JSON manifest to stdout.

Runs under the data/stem-audio-venv interpreter (see pyenv.ts) with essentia-tensorflow.
Essentia is AGPL-3.0 and only ever crosses this subprocess boundary; the MTG classifier
models are CC BY-NC-SA 4.0 (see NOTICE).

Model graph/node names were probed against the shipped .pb files:
  backbone  discogs-effnet-bs64-1.pb        embeddings at "PartitionedCall:1"
  genre400  in "serving_default_model_Placeholder"  out "PartitionedCall:0"  (softmax, 400)
  moodtheme in "model/Placeholder"                  out "model/Sigmoid"      (multi-label, 56)
  binary heads (danceability, mood_*)               out "model/Softmax"      ([positive, negative])
  regressions (approachability, engagement)         out "model/Identity"

Scalar formulas (all 0..1, from the binary heads' POSITIVE-class probability):
  danceability  = P(danceable)
  aggressiveness= P(aggressive)
  acousticness  = P(acoustic)
  valence       = (P(happy) + 1 - P(sad)) / 2          # bright vs dark
  energy        = (P(aggressive) + 1 - P(relaxed)) / 2 # arousal proxy

Manifest shape:
  {
    "durationSec": float, "bpm": float, "keyLabel": "A minor",
    "energy": float, "valence": float, "danceability": float,
    "aggressiveness": float, "acousticness": float,
    "approachability": float, "engagement": float,
    "tags": ["rock", ..., "mood/energetic", ...],   # top-8 genres + top-5 mood/themes
    "embedding": [f32 x 1280]                        # mean over patch embeddings
  }

Usage: python library_analyze.py INPUT_AUDIO MODELS_DIR
Exits non-zero with a message on stderr if analysis fails.
"""
import json
import os
import sys

try:
    import numpy as np
    import essentia
    import essentia.standard as es
except Exception as exc:  # pragma: no cover - import guard
    sys.stderr.write("essentia/numpy import failed: %s\n" % exc)
    sys.exit(2)

essentia.log.infoActive = False
essentia.log.warningActive = False

# The effnet models are trained on 16 kHz mono input.
SR = 16000


def positive_prob(head_out, classes):
    """Binary heads emit [P(positive), P(negative)] per patch — mean the positive lane.
    The metadata orders the positive class first (e.g. ["danceable", "not_danceable"])."""
    del classes
    return float(np.mean(head_out[:, 0]))


def main():
    if len(sys.argv) < 3:
        sys.stderr.write("usage: library_analyze.py INPUT_AUDIO MODELS_DIR\n")
        sys.exit(1)
    path, models = sys.argv[1], sys.argv[2]

    def model(name):
        return os.path.join(models, name)

    audio16 = es.MonoLoader(filename=path, sampleRate=SR, resampleQuality=4)()
    duration = float(len(audio16)) / SR
    if duration < 5:
        sys.stderr.write("track too short to analyse (%.1fs)\n" % duration)
        sys.exit(3)

    # ── backbone: per-patch 1280-d embeddings ────────────────────────────────
    embed_model = es.TensorflowPredictEffnetDiscogs(
        graphFilename=model("discogs-effnet-bs64-1.pb"), output="PartitionedCall:1")
    patches = embed_model(audio16)  # (nPatches, 1280)
    if patches is None or len(patches) == 0:
        sys.stderr.write("backbone produced no embeddings\n")
        sys.exit(4)
    embedding = np.mean(patches, axis=0).astype("float32")

    # ── classifier heads over the patch embeddings ───────────────────────────
    def head(name, out_node):
        return es.TensorflowPredict2D(graphFilename=model(name), output=out_node)(patches)

    # genre: softmax over 400 discogs styles, labels from the metadata JSON
    with open(model("genre_discogs400-discogs-effnet-1.json")) as fh:
        genre_classes = json.load(fh)["classes"]
    genre_act = np.mean(es.TensorflowPredict2D(
        graphFilename=model("genre_discogs400-discogs-effnet-1.pb"),
        input="serving_default_model_Placeholder", output="PartitionedCall:0")(patches), axis=0)
    genre_top = np.argsort(genre_act)[::-1][:8]
    # Labels look like "Rock---Hard Rock" — keep the specific style, lowercase.
    genre_tags = [genre_classes[i].split("---")[-1].strip().lower() for i in genre_top
                  if genre_act[i] >= 0.03]

    # mood/theme: 56-class multi-label sigmoid
    with open(model("mtg_jamendo_moodtheme-discogs-effnet-1.json")) as fh:
        mood_classes = json.load(fh)["classes"]
    mood_act = np.mean(es.TensorflowPredict2D(
        graphFilename=model("mtg_jamendo_moodtheme-discogs-effnet-1.pb"),
        input="model/Placeholder", output="model/Sigmoid")(patches), axis=0)
    mood_top = np.argsort(mood_act)[::-1][:5]
    mood_tags = ["mood/%s" % mood_classes[i].strip().lower() for i in mood_top
                 if mood_act[i] >= 0.05]

    # binary heads → scalars
    p_dance = positive_prob(head("danceability-discogs-effnet-1.pb", "model/Softmax"), None)
    p_aggr = positive_prob(head("mood_aggressive-discogs-effnet-1.pb", "model/Softmax"), None)
    p_happy = positive_prob(head("mood_happy-discogs-effnet-1.pb", "model/Softmax"), None)
    p_sad = positive_prob(head("mood_sad-discogs-effnet-1.pb", "model/Softmax"), None)
    p_relax = positive_prob(head("mood_relaxed-discogs-effnet-1.pb", "model/Softmax"), None)
    p_acoustic = positive_prob(head("mood_acoustic-discogs-effnet-1.pb", "model/Softmax"), None)

    # regressions emit one ~0..1 value per patch (probed: means 0.4-0.6, tails outside) —
    # mean then clip to the documented range
    def regression(name):
        vals = head(name, "model/Identity")
        return float(np.clip(np.mean(vals), 0.0, 1.0))

    approachability = regression("approachability_regression-discogs-effnet-1.pb")
    engagement = regression("engagement_regression-discogs-effnet-1.pb")

    # ── bpm + key (cheap ffmpeg-free DSP on the same decode) ─────────────────
    bpm, key_label = None, None
    try:
        bpm = float(es.PercivalBpmEstimator(sampleRate=SR)(audio16))
    except Exception as exc:
        sys.stderr.write("bpm skipped: %s\n" % exc)
    try:
        key, scale, _strength = es.KeyExtractor(sampleRate=SR)(audio16)
        key_label = "%s %s" % (key, scale)
    except Exception as exc:
        sys.stderr.write("key skipped: %s\n" % exc)

    manifest = {
        "durationSec": round(duration, 3),
        "bpm": round(bpm, 2) if bpm else None,
        "keyLabel": key_label,
        "energy": round((p_aggr + 1.0 - p_relax) / 2.0, 4),
        "valence": round((p_happy + 1.0 - p_sad) / 2.0, 4),
        "danceability": round(p_dance, 4),
        "aggressiveness": round(p_aggr, 4),
        "acousticness": round(p_acoustic, 4),
        "approachability": round(approachability, 4),
        "engagement": round(engagement, 4),
        "tags": genre_tags + mood_tags,
        "embedding": [round(float(x), 6) for x in embedding],
    }
    json.dump(manifest, sys.stdout)
    sys.stdout.flush()


if __name__ == "__main__":
    main()
