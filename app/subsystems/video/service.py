"""Business logic for Phase 4 video analysis."""

from __future__ import annotations

from dataclasses import dataclass

from app.providers.types import ProviderSpec
from app.subsystems.image.vision import (
    ProviderRequestError,
    VisionRequestError,
    analyze_with_provider,
    extract_image_payload,
    fallback_provider_for,
    provider_failure_message,
    select_vision_provider,
)


DEFAULT_VIDEO_PROMPT = "Describe what is happening across these sampled video frames."
FRAME_PROMPT_SUFFIX = "Focus on the visible action or scene in this frame and reply in one sentence."
MAX_VIDEO_FRAMES = 6


class VideoAnalysisError(RuntimeError):
    """Raised when video analysis cannot be completed."""


@dataclass(frozen=True)
class VideoAnalysisResult:
    """Video analysis reply plus execution metadata."""

    reply: str
    provider: ProviderSpec


def analyze_video(
    frame_data_urls: list[str],
    prompt: str,
    profile: str,
    providers: dict[str, ProviderSpec],
) -> VideoAnalysisResult:
    """Return an overall summary for one uploaded video."""
    frame_payloads = _extract_frame_payloads(frame_data_urls)
    provider = select_vision_provider(profile, providers)
    final_prompt = prompt.strip() or DEFAULT_VIDEO_PROMPT
    try:
        reply = _analyze_frames(provider, final_prompt, frame_payloads)
        return VideoAnalysisResult(reply=reply, provider=provider)
    except VisionRequestError as exc:
        raise VideoAnalysisError(str(exc)) from exc
    except ProviderRequestError as exc:
        fallback_provider = fallback_provider_for(profile, provider)
        if fallback_provider is not None:
            try:
                reply = _analyze_frames(fallback_provider, final_prompt, frame_payloads)
                return VideoAnalysisResult(reply=reply, provider=fallback_provider)
            except ProviderRequestError as fallback_exc:
                raise VideoAnalysisError(
                    provider_failure_message("Video", fallback_provider, profile, str(fallback_exc))
                ) from fallback_exc
        raise VideoAnalysisError(provider_failure_message("Video", provider, profile, str(exc))) from exc


def _extract_frame_payloads(frame_data_urls: list[str]) -> list[str]:
    """Validate and normalize sampled video-frame payloads."""
    if not frame_data_urls:
        raise VideoAnalysisError("Video uploads must include at least one sampled frame.")
    if len(frame_data_urls) > MAX_VIDEO_FRAMES:
        raise VideoAnalysisError(f"Video uploads can include up to {MAX_VIDEO_FRAMES} sampled frames.")
    try:
        return [extract_image_payload(frame) for frame in frame_data_urls]
    except VisionRequestError as exc:
        raise VideoAnalysisError(str(exc)) from exc


def _analyze_frames(provider: ProviderSpec, prompt: str, frame_payloads: list[str]) -> str:
    """Analyze each sampled frame and combine the results into one reply."""
    frame_summaries = [
        analyze_with_provider(provider, _frame_prompt(prompt, index, len(frame_payloads)), payload)
        for index, payload in enumerate(frame_payloads, start=1)
    ]
    return _combine_frame_summaries(frame_summaries)


def _frame_prompt(prompt: str, index: int, total: int) -> str:
    """Build a per-frame prompt so the provider treats frames independently."""
    return f"{prompt}\nSampled frame {index} of {total}. {FRAME_PROMPT_SUFFIX}"


def _combine_frame_summaries(frame_summaries: list[str]) -> str:
    """Collapse sampled-frame summaries into one concise response."""
    unique = list(dict.fromkeys(summary.strip() for summary in frame_summaries if summary.strip()))
    if not unique:
        raise VideoAnalysisError("Video analysis returned empty frame descriptions.")
    if len(unique) == 1:
        return f"Across the sampled frames, {unique[0]}"
    joined = " ".join(f"Frame {index}: {summary}" for index, summary in enumerate(unique, start=1))
    return f"Video summary from sampled frames: {joined}"
