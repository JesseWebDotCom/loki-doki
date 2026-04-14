"""Media augmentation — attaches optional media cards (YouTube, future:
Spotify / images) to a pipeline result so the frontend can render a
MediaBar above the assistant's text.

This is a separate phase from primary chunk execution: media producers
run in parallel *alongside* the routed skill, never in place of it.
The synthesis prompt is NOT told about media cards — they are purely a
UI augmentation, so the LLM answer stays prose-only.
"""
from lokidoki.orchestrator.media.augmentor import (
    MEDIA_ELIGIBLE_CAPABILITIES,
    YOUTUBE_NATIVE_CAPABILITIES,
    augment_with_media,
)

__all__ = [
    "MEDIA_ELIGIBLE_CAPABILITIES",
    "YOUTUBE_NATIVE_CAPABILITIES",
    "augment_with_media",
]
