#!/usr/bin/env python3
"""Forced alignment of KNOWN lyrics text to a song's isolated vocal audio, so the
per-line timestamps match THIS recording's actual singing — regardless of which
recording the lyric source (LRCLIB) happened to time its lines to.

Why this exists: LRCLIB's synced timestamps are tied to whatever upload matched by
artist/title/duration, which is frequently a different edit or re-recording than the
audio we're playing (different intro length, tempo, phrasing). A global offset can't
fix that; only aligning the words to the real audio can. See musicInfo.ts for the
version-mismatch background.

Approach: torchaudio's MMS forced-alignment bundle (a wav2vec2 CTC model). We are given
the exact words, so the model only has to find WHEN each occurs in the vocal stem. Runs
under data/stem-audio-venv (torch + torchaudio already present for Demucs). CPU-only is
fine; this is a background compute job.

Usage: python align.py VOCALS_AUDIO LYRICS_TEXT_FILE
  VOCALS_AUDIO      isolated vocals stem (mp3/wav); mixed audio also works but is less accurate
  LYRICS_TEXT_FILE  plain lyrics, one line per line (blank lines allowed)

Emits a single JSON manifest to stdout:
  {"lines": [{"sec": float, "text": "You got the touch",
              "words": [{"sec": float, "end": float, "text": "You"}, ...]}, ...],
   "alignedWords": int, "totalWords": int}
Each line's own per-word start/end times drive the karaoke wipe animation (rather than
interpolating one gradient across the whole line); a word missing from "words" means the
aligner couldn't anchor it, so the caller should keep interpolating around the gaps.
Exit non-zero with a stderr message when nothing could be aligned (caller falls back to
raw LRCLIB timing).
"""
import json
import sys
import unicodedata

try:
    import numpy as np
    import soundfile as sf
    import torch
    import torchaudio
except Exception as exc:  # pragma: no cover - import guard
    sys.stderr.write("torch/torchaudio/soundfile import failed: %s\n" % exc)
    sys.exit(2)


def load_mono(path, target_sr):
    """Decode audio (mp3/wav) to a mono float32 torch tensor [1, time] at target_sr. Uses
    soundfile (libsndfile) for decoding — torchaudio 2.x's own load() now defaults to
    TorchCodec, which isn't in the stem venv, and libsndfile reads the mp3 stems directly."""
    data, sr = sf.read(path, dtype="float32", always_2d=True)   # [time, channels]
    mono = data.mean(axis=1)                                     # -> [time]
    wav = torch.from_numpy(np.ascontiguousarray(mono)).unsqueeze(0)   # [1, time]
    if sr != target_sr:
        wav = torchaudio.functional.resample(wav, sr, target_sr)
    return wav


def normalize_word(word):
    """Fold a lyric word to the MMS aligner's latin dictionary: strip accents, lowercase,
    keep [a-z']. Returns '' for words that don't survive (punctuation, ♪, non-latin scripts —
    those lines simply won't get their own anchor and are interpolated later)."""
    decomposed = unicodedata.normalize("NFKD", word)
    ascii_only = "".join(c for c in decomposed if not unicodedata.combining(c))
    out = []
    for ch in ascii_only.lower():
        if ("a" <= ch <= "z") or ch == "'":
            out.append(ch)
    return "".join(out).strip("'")


def main():
    if len(sys.argv) < 3:
        sys.stderr.write("usage: align.py VOCALS_AUDIO LYRICS_TEXT_FILE\n")
        sys.exit(1)
    audio_path, text_path = sys.argv[1], sys.argv[2]

    with open(text_path, "r", encoding="utf-8") as fh:
        raw_lines = [ln.rstrip("\n") for ln in fh]

    # Build the flat word transcript, remembering which line each word came from so we can
    # collapse word timings back to per-line anchors. Keep every original line (even blank /
    # unalignable ones) so the output structure matches the source lyrics.
    lines = []          # {"text": str, "word_idx": [global indices], "sec": None}
    transcript = []     # normalized words fed to the aligner, in order
    raw_tokens = []     # original (unnormalized) token text, parallel to transcript
    for text in raw_lines:
        entry = {"text": text, "word_idx": [], "sec": None}
        for tok in text.split():
            norm = normalize_word(tok)
            if norm:
                entry["word_idx"].append(len(transcript))
                transcript.append(norm)
                raw_tokens.append(tok)
        lines.append(entry)

    total_words = len(transcript)
    if total_words == 0:
        sys.stderr.write("no alignable words in lyrics\n")
        sys.exit(3)

    torch.set_num_threads(max(1, (torch.get_num_threads() or 4)))
    bundle = torchaudio.pipelines.MMS_FA
    sample_rate = bundle.sample_rate
    model = bundle.get_model()      # downloads to TORCH_HOME/hub on first use
    tokenizer = bundle.get_tokenizer()
    aligner = bundle.get_aligner()
    model.eval()

    waveform = load_mono(audio_path, sample_rate)

    with torch.inference_mode():
        emission, _ = model(waveform)
        token_spans = aligner(emission[0], tokenizer(transcript))

    num_frames = emission.size(1)
    samples = waveform.size(1)
    # seconds-per-emission-frame = (samples / frames) / sample_rate
    ratio = (samples / num_frames) / sample_rate

    # Per-word start time (seconds), indexed by global word position. NOTE: the MMS aligner's
    # per-token `score` is NOT usable to reject bad anchors on sung vocals — measured scores are
    # uniformly tiny (median ~0.08) and don't separate good alignments from bad, so any threshold
    # either nulls almost everything or catches nothing. We trust the measured onsets directly; a
    # rare misplaced line is preferable to interpolating the whole song between a few points.
    word_start = [None] * total_words
    word_end = [None] * total_words
    for gi, spans in enumerate(token_spans):
        if gi < total_words and spans:
            word_start[gi] = round(float(spans[0].start) * ratio, 3)
            word_end[gi] = round(float(spans[-1].end) * ratio, 3)

    # A line's anchor is its first aligned word's start; its "words" list carries every
    # aligned word's own start/end so the caller can pace the wipe word-by-word instead of
    # smearing one gradient across the whole line.
    for entry in lines:
        words = []
        for gi in entry["word_idx"]:
            if word_start[gi] is not None:
                if entry["sec"] is None:
                    entry["sec"] = word_start[gi]
                words.append({"sec": word_start[gi], "end": word_end[gi], "text": raw_tokens[gi]})
        entry["words"] = words

    aligned_words = sum(1 for w in word_start if w is not None)
    if aligned_words == 0:
        sys.stderr.write("aligner produced no word timings\n")
        sys.exit(3)

    # Reject anchors that break the song's time order: a misfired anchor used to get sorted
    # into the wrong spot in the display order, where the line showed for a fraction of a
    # second at the wrong moment ("flashed on and then it was gone"). Keep the longest
    # non-decreasing subsequence of anchors (so one bad anchor is dropped no matter where it
    # lands — even first) and null the rest; nulled lines are re-timed by interpolation
    # below, in their correct text position.
    anchored = [idx for idx, e in enumerate(lines) if e["sec"] is not None]
    if len(anchored) > 1:
        best_len = [1] * len(anchored)   # LIS lengths over the anchored lines' secs
        best_prev = [-1] * len(anchored)
        for b in range(1, len(anchored)):
            for a in range(b):
                if lines[anchored[a]]["sec"] <= lines[anchored[b]]["sec"] and best_len[a] + 1 > best_len[b]:
                    best_len[b] = best_len[a] + 1
                    best_prev[b] = a
        end = max(range(len(anchored)), key=lambda k: best_len[k])
        keep = set()
        while end != -1:
            keep.add(anchored[end])
            end = best_prev[end]
        for idx in anchored:
            if idx not in keep:
                lines[idx]["sec"] = None
                lines[idx]["words"] = []

    # Re-time unanchored lines (blank, ♪, non-latin, rejected misfires) by spacing them
    # evenly between the surrounding good anchors — carrying the previous anchor verbatim
    # gave runs of equal timestamps, and the display scan skips all but the last of an
    # equal-time group, so those lines never appeared at all.
    n = len(lines)
    i = 0
    while i < n:
        if lines[i]["sec"] is not None:
            i += 1
            continue
        j = i
        while j < n and lines[j]["sec"] is None:
            j += 1
        prev_sec = lines[i - 1]["sec"] if i > 0 else 0.0
        next_sec = lines[j]["sec"] if j < n else prev_sec + 3.0 * (j - i)
        span = max(0.01 * (j - i + 1), next_sec - prev_sec)
        for k in range(i, j):
            lines[k]["sec"] = round(prev_sec + span * (k - i + 1) / (j - i + 1), 3)
        i = j

    # Keep only lines with visible text; a purely-blank source line carries no lyric.
    # Monotonic by construction now — no sort, so text order is always preserved.
    out_lines = [{"sec": e["sec"], "text": e["text"], "words": e["words"]} for e in lines if e["text"].strip()]

    json.dump({"lines": out_lines, "alignedWords": aligned_words, "totalWords": total_words}, sys.stdout)
    sys.stdout.flush()


if __name__ == "__main__":
    main()
