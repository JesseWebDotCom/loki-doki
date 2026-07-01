import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Play, Pause, SkipForward, SkipBack, Radio, Mic, Film, Plus, Loader2, type LucideIcon } from 'lucide-react'
import { proxyImg } from '@/lib/img'
import { ytImageProxy } from '@/lib/youtube/api'
import { useRadio } from '@/context/RadioContext'
import { djStationById } from '@/lib/music/catalogApi'
import { StationArt } from '@/components/music/StationArt'

// Server-rendered controller (button-grid) page — also a live, interactive control
// surface in a browser (clicking a tile drives this tab's player; the tile reflects live
// state). The device blits the rendered image and overlays an invisible touch grid. The
// BOTTOM grid row is left empty for the device's global controls. Each key is a glossy,
// raised "clear-plastic" cap with a reflective bevel all the way around, artwork that
// fills the whole face, and the LABEL underneath the key.

const FRAME_W = 1280
const FRAME_H = 720
const RING = '#38bdf8' // active accent

interface Btn {
  id: string; row: number; col: number; icon: string; label: string
  bgColor: string; textColor?: string; image?: string; accent?: string; category?: string
  action?: Record<string, unknown>
}
export interface ControllerPage {
  id: string; name: string; gridRows: number; gridCols: number; sortOrder: number; buttons: Btn[]
}

// YouTube art goes through the YT-specific proxy (the generic /api/img rejects ytimg);
// other remote art through the read-through cache; same-origin paths pass straight.
// ytimg variants are normalized to 16:9 mqdefault — hqdefault/sddefault are 4:3 with baked-in
// black bars, which letterbox the (square) tiles.
const artSrc = (img?: string): string | null => {
  if (!img) return null
  // Same-origin / already-proxied paths (e.g. /api/youtube/img?u=…) pass straight through —
  // re-proxying would double-wrap and 404.
  if (!/^https?:\/\//.test(img)) return img
  if (/ytimg\.com|img\.youtube\.com/.test(img)) {
    // Match ANY ytimg host (i.ytimg.com, i1–i9.ytimg.com…) and force the 16:9 mqdefault —
    // hqdefault/sddefault are 4:3 with baked-in black bars.
    const m = img.match(/\/vi\/([^/]+)\//)
    return ytImageProxy(m ? `https://i.ytimg.com/vi/${m[1]}/mqdefault.jpg` : img)
  }
  return proxyImg(img)
}

function glyphFor(a: Record<string, unknown>, playing: boolean): LucideIcon {
  if (a.type === 'play_station') return Radio
  if (a.type === 'app_action') {
    if (a.action === 'play_pause') return playing ? Pause : Play
    if (a.action === 'next_track') return SkipForward
    if (a.action === 'prev_track') return SkipBack
  }
  if (a.type === 'navigate') {
    if (a.app === 'youtube') return Film
    if (a.app === 'podcasts') return Mic
    if (a.app === 'music') return Radio
  }
  return a.stationId ? Radio : Plus
}

interface NowPlaying { stationId: string | null; videoId: string | null; title: string; artist: string | null; cover: string; positionSec: number; durationSec: number; playing: boolean }

export function ControllerDisplay({ page, interactive = false, deviceId = '' }: { page: ControllerPage; interactive?: boolean; deviceId?: string }) {
  const cols = page.gridCols || 5
  const rows = page.gridRows || 3
  const cellW = FRAME_W / cols
  const cellH = FRAME_H / rows
  const radio = useRadio()
  const navigate = useNavigate()

  // The device render is a separate headless tab that can't see the user's player, so it
  // polls the server's now-playing snapshot; an interactive browser uses its own player.
  const [serverNp, setServerNp] = useState<NowPlaying | null>(null)
  useEffect(() => {
    if (interactive) return
    let alive = true
    const tick = async () => {
      try {
        const r = await fetch(`/api/pod/now-playing${deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : ''}`, { credentials: 'include' })
        if (r.ok && alive) setServerNp(await r.json())
      } catch { /* keep last */ }
    }
    void tick()
    const t = setInterval(tick, 2000)
    return () => { alive = false; clearInterval(t) }
  }, [interactive, deviceId])

  const np: NowPlaying = interactive
    ? {
        stationId: radio.station?.id ?? null, videoId: radio.currentTrack?.videoId ?? null,
        title: radio.currentTrack?.title ?? '', artist: radio.currentTrack?.author ?? null,
        cover: radio.currentTrack?.thumbnail ?? (radio.currentTrack?.videoId ? `https://i.ytimg.com/vi/${radio.currentTrack.videoId}/mqdefault.jpg` : ''),
        positionSec: radio.positionSec, durationSec: radio.durationSec, playing: radio.active && !radio.paused,
      }
    : (serverNp ?? { stationId: null, videoId: null, title: '', artist: null, cover: '', positionSec: 0, durationSec: 0, playing: false })
  const playing = np.playing

  // Optimistic selection: highlight + spin the tapped station immediately (it takes ~1 s to
  // load, so without this it feels unresponsive). Cleared once the player confirms it
  // (now-playing reflects it) or after a safety timeout.
  const [pending, setPending] = useState<string | null>(null)
  useEffect(() => { if (pending && (np.stationId === pending || np.videoId === pending)) setPending(null) }, [np.stationId, np.videoId, pending])

  const isActive = (a: Record<string, unknown>): boolean => {
    if (a.type === 'play_station') return a.stationId === pending || (!!np.stationId && np.stationId === a.stationId)
    if (a.type === 'app_action' && a.action === 'play_pause') return playing
    return false
  }
  const isLoading = (a: Record<string, unknown>): boolean =>
    a.type === 'play_station' && a.stationId === pending && np.stationId !== a.stationId

  // Content tiles navigate; station + playback tiles act in place so the tile can show its
  // active/selected state (no navigating away from the controller).
  const onTile = async (a: Record<string, unknown>) => {
    if (!interactive) return
    try {
      if (a.type === 'play_station' && typeof a.stationId === 'string') {
        const id = a.stationId
        setPending(id)
        setTimeout(() => setPending((p) => (p === id ? null : p)), 8000)
        const dj = await djStationById(id)
        if (dj) radio.start(dj)
        else setPending(null)
      } else if (a.type === 'app_action') {
        if (a.action === 'play_pause') radio.togglePause()
        else if (a.action === 'next_track') radio.skip()
        else if (a.action === 'prev_track') radio.seek(0)
      } else if (a.type === 'navigate') {
        if (a.app === 'youtube' && typeof a.videoId === 'string') navigate(`/youtube/watch/${a.videoId}`)
        else if (typeof a.app === 'string') navigate(`/${a.app}`)
      }
    } catch (e) { console.warn('[controller] action failed', e) }
  }

  return (
    <div style={{ position: 'absolute', inset: 0, background: '#0a0a0f' }}>
      {page.buttons.map((b) => {
        const a = b.action ?? {}
        const active = isActive(a)
        let label = b.label
        if (a.type === 'app_action' && a.action === 'play_pause') label = playing ? 'Pause' : 'Play'
        const station = a.type === 'play_station'
          ? { name: b.label, accent: b.accent ?? null, category: b.category ?? null, iconUrl: b.image ?? null }
          : null
        return (
          <Tile
            key={b.id} left={b.col * cellW} top={b.row * cellH} cellW={cellW} cellH={cellH}
            bg={b.bgColor || '#1e1e2e'} img={artSrc(b.image)} Glyph={glyphFor(a, playing)} label={label}
            station={station} active={active} loading={isLoading(a)} interactive={interactive} onClick={() => { void onTile(a) }}
          />
        )
      })}
      {/* Now-playing + progress, bottom-centre. Only in the INTERACTIVE (web) surface —
          the DEVICE draws its own native player bar over this render, so rendering one here
          too would double it up. */}
      {interactive && np.title && <NowPlayingBar np={np} />}
      {/* Current time, under the now-playing bar. */}
      <CurrentTime />
    </div>
  )
}

function CurrentTime() {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const time = new Date(now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return (
    <div style={{
      position: 'absolute', left: '50%', bottom: 18, transform: 'translateX(-50%)',
      color: 'rgba(255,255,255,0.78)', fontSize: 24, fontWeight: 600, letterSpacing: 0.5,
      textShadow: '0 1px 3px rgba(0,0,0,0.7)',
    }}>{time}</div>
  )
}

function NowPlayingBar({ np }: { np: NowPlaying }) {
  const pct = np.durationSec > 0 ? Math.min(100, (np.positionSec / np.durationSec) * 100) : 0
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
  const cover = np.cover ? artSrc(np.cover) : null
  return (
    <div style={{
      position: 'absolute', left: '50%', bottom: 28, transform: 'translateX(-50%)', width: 760, maxWidth: '74%',
      display: 'flex', alignItems: 'center', gap: 18,
      background: 'rgba(10,12,20,0.86)', borderRadius: 20, padding: '14px 24px',
      border: '1px solid rgba(255,255,255,0.12)', boxShadow: '0 10px 26px rgba(0,0,0,0.55)',
    }}>
      {/* Cover on the LEFT */}
      <div style={{ flex: '0 0 auto', width: 76, height: 76, borderRadius: 12, overflow: 'hidden', background: '#1e1e2e', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {cover
          ? <img src={cover} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
          : <Radio size={34} color="rgba(255,255,255,0.7)" />}
      </div>
      {/* Title + artist + progress (bigger) */}
      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          {np.playing ? <Pause size={24} color="#38bdf8" /> : <Play size={24} color="rgba(255,255,255,0.85)" />}
          <span style={{ color: '#fff', fontSize: 30, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {np.title}{np.artist ? ` — ${np.artist}` : ''}
          </span>
        </div>
        <div style={{ position: 'relative', height: 10, borderRadius: 5, background: 'rgba(255,255,255,0.20)' }}>
          <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pct}%`, borderRadius: 5, background: '#38bdf8' }} />
        </div>
        {np.durationSec > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, color: 'rgba(255,255,255,0.7)', fontSize: 18 }}>
            <span>{fmt(np.positionSec)}</span><span>{fmt(np.durationSec)}</span>
          </div>
        )}
      </div>
    </div>
  )
}

function Tile({ left, top, cellW, cellH, bg, img, Glyph, label, station, active, loading, interactive, onClick }: {
  left: number; top: number; cellW: number; cellH: number; bg: string; img: string | null
  Glyph: LucideIcon; label: string
  station: { name: string; accent: string | null; category: string | null; iconUrl: string | null } | null
  active: boolean; loading: boolean; interactive: boolean; onClick: () => void
}) {
  const LABEL_H = 34
  const S = Math.min(cellW - 22, cellH - LABEL_H - 18) // square keycap; room for label underneath
  return (
    <div style={{
      position: 'absolute', left, top, width: cellW, height: cellH,
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start',
      paddingTop: 10, cursor: interactive ? 'pointer' : 'default',
    }} onClick={interactive ? onClick : undefined}>
      {/* Reflective rim ALL AROUND (bright top-left → light bottom for a wrap reflection). */}
      <div style={{
        width: S, height: S, borderRadius: 26, padding: 3,
        background: active
          ? `linear-gradient(160deg, ${RING}, rgba(56,189,248,0.5) 50%, rgba(56,189,248,0.85))`
          : 'linear-gradient(160deg, rgba(255,255,255,0.6) 0%, rgba(255,255,255,0.12) 32%, rgba(255,255,255,0.06) 64%, rgba(255,255,255,0.28) 100%)',
        transform: active ? 'translateY(2px) scale(0.97)' : 'none',
        transition: 'transform 90ms ease',
        boxShadow: active
          ? `0 0 30px 4px rgba(56,189,248,0.7), 0 2px 4px rgba(0,0,0,0.5)`
          : '0 12px 22px rgba(0,0,0,0.6), 0 4px 8px rgba(0,0,0,0.55)',
      }}>
        <div style={{
          position: 'relative', width: '100%', height: '100%', borderRadius: 23, overflow: 'hidden', background: bg,
          boxShadow: active
            ? 'inset 0 5px 16px rgba(0,0,0,0.85)'
            : 'inset 0 2px 1px rgba(255,255,255,0.5), inset 0 -10px 18px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(255,255,255,0.10)',
        }}>
          {station ? (
            /* Stations use the music app's exact look: accent gradient + thematic watermark
               (or a real photo when the station has one). Name is rendered underneath. */
            <StationArt station={station} showName={false} />
          ) : (
            <>
              {/* Depth gradient over the accent (a "proper background" for art-less tiles). */}
              <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(155deg, rgba(255,255,255,0.20) 0%, rgba(0,0,0,0.10) 45%, rgba(0,0,0,0.45) 100%)', pointerEvents: 'none' }} />
              {/* Glyph underlay (shows when artwork is absent or fails). */}
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Glyph size={Math.round(S * 0.4)} color="rgba(255,255,255,0.92)" strokeWidth={2} />
              </div>
              {/* Artwork fills the whole face (cover = zoom/crop, never letterboxed). */}
              {img && (
                <img src={img} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
              )}
            </>
          )}
          {/* Clear-plastic cover: glossy top sheen + diagonal glare. */}
          <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: '52%', pointerEvents: 'none',
            background: 'linear-gradient(180deg, rgba(255,255,255,0.38) 0%, rgba(255,255,255,0.12) 40%, rgba(255,255,255,0) 100%)' }} />
          <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none',
            background: 'radial-gradient(130% 80% at 22% -10%, rgba(255,255,255,0.28), rgba(255,255,255,0) 55%)' }} />
          {/* Loading: spinner over a dim scrim while the tapped station starts. */}
          {loading && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.45)' }}>
              <Loader2 className="animate-spin" size={Math.round(S * 0.32)} color="#fff" strokeWidth={2.5} />
            </div>
          )}
        </div>
      </div>
      {/* Label UNDERNEATH the key. */}
      <div style={{
        marginTop: 8, maxWidth: cellW - 12, color: active ? RING : '#e5e7eb',
        fontSize: 22, fontWeight: 600, textAlign: 'center',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textShadow: '0 1px 2px rgba(0,0,0,0.7)',
      }}>{label}</div>
    </div>
  )
}
