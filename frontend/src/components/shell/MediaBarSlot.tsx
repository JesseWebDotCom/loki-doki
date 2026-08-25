import { useSyncExternalStore } from "react";
import { useLocation } from "react-router-dom";
import { getActiveSource, pickMediaWinner, subscribeActiveSource, type MediaSource } from "@/lib/mediaCoordinator";
import { useYoutubePlayback } from "@/context/YoutubePlaybackContext";
import { useRadio } from "@/context/RadioContext";
import { useLiveRadio } from "@/context/LiveRadioContext";
import { usePodcastPlayback } from "@/context/PodcastPlaybackContext";
import { usePlayerOverlay } from "@/context/PlayerOverlayContext";
import { YoutubeMiniBar } from "@/components/youtube/YoutubeMiniBar";
import { RadioMiniBar } from "@/components/music/RadioMiniBar";
import { LiveRadioMiniBar } from "@/components/music/LiveRadioMiniBar";
import { PodcastPlayerBar } from "@/components/podcast/PodcastPlayerBar";

// The ONE app-wide media bar slot. Exactly one mini-player renders at a time:
// the most-recently-acquired audio source wins (mediaCoordinator), with a
// presence-order fallback. Historically PodcastPlayerBar was an unarbitrated
// sibling of YoutubeMiniBar (which internally swapped in the radio bars), so a
// podcast bar could stack on top of a radio bar on top of the dock. Route
// redundancy rules also live here: a bar hides where its full player already
// owns the screen (watch pages, the Now Playing overlay deep-link route).
export function MediaBarSlot() {
  const activeSource = useSyncExternalStore(subscribeActiveSource, getActiveSource);
  const yt = useYoutubePlayback();
  const radio = useRadio();
  const live = useLiveRadio();
  const pod = usePodcastPlayback();
  const { pathname, search } = useLocation();
  // The full music player / immersive visualizer ARE the radio controls; showing the
  // radio mini bar underneath them duplicates the transport (play/next twice on screen).
  const { open: playerOpen, immersive } = usePlayerOverlay();
  const radioPlayerUp = playerOpen || immersive;

  // Any full-screen watch surface (video watch pages, music video page).
  const onWatch =
    pathname.startsWith("/videos/youtube/shorts") ||
    pathname.startsWith("/music/watch") ||
    /^\/videos\/[^/]+\/watch\//.test(pathname);
  // Legacy radio tab URL (full controller on screen).
  const onRadioTab = pathname === "/music" && new URLSearchParams(search).get("tab") === "radio";
  // The Now Playing deep-link route raises the full overlay; a mini bar under it
  // would render the same track twice.
  const onNowPlayingPage = pathname.startsWith("/music/now-playing");

  const present: Record<Exclude<MediaSource, "studio">, boolean> = {
    podcast: !!pod.track,
    youtube: !!yt.track && !onWatch,
    radio: radio.active && !yt.track && !onRadioTab && !onNowPlayingPage && !onWatch && !radioPlayerUp,
    liveRadio: live.active && !yt.track && !radio.active && !onWatch,
    // MaiPai TV never shows a mini bar: the watch page owns its whole surface.
    tv: false,
  };

  const winner: MediaSource | null = pickMediaWinner(present, activeSource);

  return (
    <>
      {/* Always mounted: it owns the YT iframe / <video> / stream <audio> elements,
          and unmounting would kill playback. Only its visibility toggles. */}
      <YoutubeMiniBar visible={winner === "youtube"} />
      {winner === "podcast" && <PodcastPlayerBar />}
      {winner === "radio" && <RadioMiniBar />}
      {winner === "liveRadio" && <LiveRadioMiniBar />}
    </>
  );
}
