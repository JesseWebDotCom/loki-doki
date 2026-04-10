from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(eq=True, frozen=True)
class SpeechSegment:
    text: str
    length_scale: float
    post_silence_s: float


def plan_prosody(text: str, *, base_length_scale: float = 1.0, sentence_pause: float = 0.4) -> list[SpeechSegment]:
    cleaned = str(text or "").strip()
    if not cleaned:
        return []
    list_mode = _is_list_text(cleaned)
    raw_segments = _split_segments(cleaned)
    out: list[SpeechSegment] = []
    for idx, segment in enumerate(raw_segments):
        length_scale = _segment_rate(segment, idx=idx, total=len(raw_segments), base=base_length_scale, list_mode=list_mode)
        silence = _segment_pause(segment, idx=idx, total=len(raw_segments), base=sentence_pause, list_mode=list_mode)
        out.append(
            SpeechSegment(
                text=segment,
                length_scale=round(max(0.85, min(1.15, length_scale)), 2),
                post_silence_s=round(max(0.0, silence), 2),
            )
        )
    if out:
        out[-1] = SpeechSegment(text=out[-1].text, length_scale=out[-1].length_scale, post_silence_s=0.0)
    return out


def build_silence_pcm(*, sample_rate: int, duration_s: float) -> bytes:
    frames = max(int(sample_rate * max(duration_s, 0.0)), 0)
    return b"\x00\x00" * frames


def _split_segments(text: str) -> list[str]:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if _is_list_text(text):
        return [re.sub(r"^(?:[-*]|\d+\.)\s+", "", line).strip() for line in lines]
    protected = re.sub(r"\b(Dr|Mr|Mrs|Ms|Prof|St)\.", lambda m: m.group(1) + "<prd>", text)
    parts = re.split(r"(?<=[.!?])\s+", protected)
    parts = [part.replace("<prd>", ".") for part in parts]
    return [part.strip() for part in parts if part.strip()]


def _segment_rate(segment: str, *, idx: int, total: int, base: float, list_mode: bool) -> float:
    lower = segment.lower()
    if list_mode:
        return base
    if lower.startswith(("also,", "also ", "by the way", "oh and")):
        return base - 0.05
    if any(word in lower for word in ("sorry", "hard", "tough", "glad", "love", "care")):
        return base + 0.05
    return base


def _segment_pause(segment: str, *, idx: int, total: int, base: float, list_mode: bool) -> float:
    if idx >= total - 1:
        return 0.0
    if list_mode:
        return 0.3
    if segment.endswith("?"):
        return base + 0.2
    if "\n\n" in segment:
        return max(base, 0.5)
    return base


def _is_list_text(text: str) -> bool:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return len(lines) > 1 and all(re.match(r"^(?:[-*]|\d+\.)\s+", line) for line in lines)
