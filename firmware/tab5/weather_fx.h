// Native LVGL animated weather effects for the Tab5 dashboard.
//
// Two things, driven by the WMO weather code + day/night from the server's display.data:
//   1. apply_weather_fx(layer, code, day) — fills a full-screen background layer with the
//      right animated PARTICLES (rain streaks, snow, lightning flash, drifting clouds,
//      fog bands, night stars). Rebuilt on every weather change (lv_obj_clean drops the old
//      particles AND their animations).
//   2. animate_weather_icon(icon, code, day) — a gentle motion on the card glyph (bob, or a
//      twinkle for the sun) so it isn't static.
//
// Everything is offloaded to LVGL's animation engine (lv_anim), so there's no per-frame
// lambda — LVGL drives it. Particle counts are kept modest for the panel's redraw budget.

#pragma once
#ifdef USE_LVGL
#include "lvgl.h"
#include <cstdlib>

namespace wxfx {

inline int rnd(int lo, int hi) { return lo + (rand() % (hi - lo + 1)); }

// Character SPRITE images (anti-aliased art), filled at startup:
//   0 balloon,1 ufo,2 kite,3 airplane(level),4 bird(up),5 satellite,6 petal,7 leaf,
//   8 bird(down),9 airplane(full bank A),10 airplane(full bank B),
//   11 airplane(half bank A),12 airplane(half bank B),13 cloud,14 pine,
//   15 sunglasses,16 jacket,17 umbrella,18 scarf,19 tee (apparel icons),
//   20 cow,21 comet,22 blimp,23 tractor-beam,24 tractor,25 barn,26 helicopter,27 house.
inline const lv_image_dsc_t **sprite_table() { static const lv_image_dsc_t *t[28] = {}; return t; }

// Suggested-wear icons for the conditions (mirrors the web app's apparelFor): fills up to
// three image slots and hides the rest. umbrella for wet, scarf for snow, jacket when cold,
// sunglasses on a warm clear/partly day, tee as the mild-and-dry default.
inline void apply_apparel(lv_obj_t *s0, lv_obj_t *s1, lv_obj_t *s2, int code, bool day, int temp) {
  lv_obj_t *slot[3] = {s0, s1, s2};
  int items[3]; int n = 0;
  bool umbrella = (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || (code >= 95);
  bool snow     = (code >= 71 && code <= 77) || (code >= 85 && code <= 86);
  if (umbrella)                          items[n++] = 17;
  if (snow && n < 3)                     items[n++] = 18;
  if (temp <= 50 && n < 3)               items[n++] = 16;
  if (code <= 2 && day && temp >= 62 && n < 3) items[n++] = 15;
  if (n == 0)                            items[n++] = 19;
  const lv_image_dsc_t **t = sprite_table();
  for (int k = 0; k < 3; k++) {
    if (k < n && t[items[k]]) {
      lv_image_set_src(slot[k], t[items[k]]);
      lv_obj_remove_flag(slot[k], LV_OBJ_FLAG_HIDDEN);
    } else {
      lv_obj_add_flag(slot[k], LV_OBJ_FLAG_HIDDEN);
    }
  }
}

inline void set_frame(lv_obj_t *o, int idx) {
  const lv_image_dsc_t **t = sprite_table();
  if (t[idx] && lv_image_get_src(o) != t[idx]) lv_image_set_src(o, t[idx]);
}

// Bird wing-flap: swap between the up (4) and down (8) frames at the animation midpoint.
inline void bird_flap_exec(void *var, int32_t v) { set_frame((lv_obj_t *) var, (v > 50) ? 8 : 4); }

// Plane banking: sweep smoothly through level → half → full → half → level → … in BOTH
// directions, using the in-between (half-bank) frames so the roll eases instead of snapping.
inline void plane_bank_exec(void *var, int32_t v) {
  //         level a2  a   a2  level b2  b   b2   (a = bank A, b = bank B; 2 = half)
  static const int SEQ[8] = {3, 11, 9, 11, 3, 12, 10, 12};
  int seg = (v * 8) / 3601; if (seg > 7) seg = 7;
  set_frame((lv_obj_t *) var, SEQ[seg]);
}
inline lv_obj_t *spr(lv_obj_t *layer, int idx, int scale) {
  lv_obj_t *im = lv_image_create(layer);
  const lv_image_dsc_t **t = sprite_table();
  if (t[idx]) lv_image_set_src(im, t[idx]);
  if (scale != 256) lv_image_set_scale(im, scale);
  lv_obj_remove_flag(im, (lv_obj_flag_t) (LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE));
  return im;
}

// A bare, non-interactive child object (no default styling / scrolling / click).
inline lv_obj_t *chip(lv_obj_t *parent, int w, int h, uint32_t color, lv_opa_t opa, int radius) {
  lv_obj_t *o = lv_obj_create(parent);
  lv_obj_remove_style_all(o);
  lv_obj_set_size(o, w, h);
  lv_obj_set_style_bg_color(o, lv_color_hex(color), 0);
  lv_obj_set_style_bg_opa(o, opa, 0);
  lv_obj_set_style_radius(o, radius, 0);
  lv_obj_remove_flag(o, (lv_obj_flag_t) (LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE));
  return o;
}

inline void anim_y(lv_obj_t *o, int from, int to, uint32_t dur, uint32_t delay) {
  lv_anim_t a; lv_anim_init(&a);
  lv_anim_set_var(&a, o);
  lv_anim_set_values(&a, from, to);
  lv_anim_set_duration(&a, dur);
  lv_anim_set_delay(&a, delay);
  lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
  lv_anim_set_exec_cb(&a, [](void *v, int32_t y) { lv_obj_set_y((lv_obj_t *) v, y); });
  lv_anim_start(&a);
}

inline void anim_x(lv_obj_t *o, int from, int to, uint32_t dur, uint32_t delay) {
  lv_anim_t a; lv_anim_init(&a);
  lv_anim_set_var(&a, o);
  lv_anim_set_values(&a, from, to);
  lv_anim_set_duration(&a, dur);
  lv_anim_set_delay(&a, delay);
  lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
  lv_anim_set_exec_cb(&a, [](void *v, int32_t x) { lv_obj_set_x((lv_obj_t *) v, x); });
  lv_anim_start(&a);
}

// ── Effects ───────────────────────────────────────────────────────────────────────
// Rain: thin vertical streaks falling; `drift` slants them sideways (wind).
inline void rain(lv_obj_t *layer, int n, int drift, uint32_t color) {
  for (int i = 0; i < n; i++) {
    int x = rnd(-40, 1280);
    lv_obj_t *d = chip(layer, 3, rnd(16, 28), color, LV_OPA_70, 2);
    lv_obj_set_x(d, x);
    uint32_t dur = (uint32_t) rnd(1000, 1700);   // slower, calmer fall
    anim_y(d, -40, 760, dur, rnd(0, 1800));
    if (drift) anim_x(d, x, x + drift, dur, 0);
  }
}

// Snow: small soft circles drifting down slowly, with a little sideways sway.
inline void snow(lv_obj_t *layer, int n) {
  for (int i = 0; i < n; i++) {
    int sz = rnd(5, 10);
    int x = rnd(0, 1280);
    lv_obj_t *f = chip(layer, sz, sz, 0xFFFFFF, LV_OPA_80, LV_RADIUS_CIRCLE);
    lv_obj_set_x(f, x);
    uint32_t dur = (uint32_t) rnd(2600, 4200);
    anim_y(f, -20, 760, dur, rnd(0, 2500));
    anim_x(f, x - rnd(12, 40), x + rnd(12, 40), rnd(1800, 3200), rnd(0, 1000));
  }
}

// Lightning: a full-screen pale flash that fires every few seconds.
inline void lightning(lv_obj_t *layer) {
  lv_obj_t *flash = chip(layer, 1280, 720, 0xC9D6FF, LV_OPA_TRANSP, 0);
  lv_obj_set_pos(flash, 0, 0);
  lv_anim_t a; lv_anim_init(&a);
  lv_anim_set_var(&a, flash);
  lv_anim_set_values(&a, 0, 190);
  lv_anim_set_duration(&a, 110);
  lv_anim_set_playback_duration(&a, 240);
  lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
  lv_anim_set_repeat_delay(&a, 2800);
  lv_anim_set_exec_cb(&a, [](void *v, int32_t o) { lv_obj_set_style_bg_opa((lv_obj_t *) v, (lv_opa_t) o, 0); });
  lv_anim_start(&a);
}

// Drifting clouds — a SUBTLE layered-parallax field (the technique real weather apps use):
// each cloud gets a random depth → far ones are small, faint and slow; near ones are larger
// and a touch bolder but still translucent. Soft alpha-blurred sprite = no clipart edges.
// `opa` is the near-cloud opacity ceiling (kept well below opaque so they read as background).
inline void clouds(lv_obj_t *layer, int n, lv_opa_t opa, bool day) {
  for (int i = 0; i < n; i++) {
    int depth = rnd(0, 100);                              // 0 = far (faint/slow), 100 = near
    int scale = 150 + depth * 14 / 10;                   // ~150 (far) .. ~290 (near) — softer + cheaper
    lv_opa_t o = (lv_opa_t) (40 + depth * (opa - 40) / 100);   // far faint, near → ceiling
    lv_obj_t *c = spr(layer, 13, scale);
    lv_obj_set_style_image_opa(c, o, 0);
    if (!day) lv_obj_set_style_image_recolor_opa(c, LV_OPA_50, 0),               // dim at night
              lv_obj_set_style_image_recolor(c, lv_color_hex(0x39435A), 0);
    lv_obj_set_y(c, rnd(2, 132));   // UPPER sky only — never behind the clock / weather text
    uint32_t dur = (uint32_t) (40000 - depth * 210);     // far drifts slow, near a bit faster
    anim_x(c, -300, 1360, dur, rnd(0, 13000));           // parks fully off-screen between passes
  }
}

// Fog/haze: a few wide translucent bands easing left↔right.
inline void fog(lv_obj_t *layer) {
  for (int i = 0; i < 4; i++) {
    lv_obj_t *b = chip(layer, 1500, rnd(90, 150), 0xAEB6C2, LV_OPA_30, 0);
    int y = 80 + i * 150;
    lv_obj_set_y(b, y);
    anim_x(b, -120, -40, rnd(5000, 9000), rnd(0, 3000));
  }
}

// Twinkle: pulse an object's opacity between lo and hi forever.
inline void twinkle(lv_obj_t *o, int lo, int hi) {
  lv_anim_t a; lv_anim_init(&a);
  lv_anim_set_var(&a, o);
  lv_anim_set_values(&a, lo, hi);
  lv_anim_set_duration(&a, rnd(900, 2200));
  lv_anim_set_playback_duration(&a, rnd(900, 2200));
  lv_anim_set_delay(&a, rnd(0, 1500));
  lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
  lv_anim_set_exec_cb(&a, [](void *v, int32_t op) { lv_obj_set_style_bg_opa((lv_obj_t *) v, (lv_opa_t) op, 0); });
  lv_anim_start(&a);
}

// One depth layer of stars. Closer layers are bigger, brighter, and (if drift_ms != 0)
// drift left faster — continuous, SEAMLESS wrap (moving exactly one screen width and
// wrapping returns each star to its start, so the infinite repeat has no visible jump).
// drift_ms == 0 → a static layer (cheap; pure depth).
inline void star_layer(lv_obj_t *layer, int n, int sz, uint32_t color, lv_opa_t opa,
                       uint32_t drift_ms, bool tw) {
  for (int i = 0; i < n; i++) {
    lv_obj_t *s = chip(layer, sz, sz, color, opa, LV_RADIUS_CIRCLE);
    int x = rnd(0, 1319), y = rnd(0, 470);
    lv_obj_set_pos(s, x, y);
    if (drift_ms) {
      lv_anim_t a; lv_anim_init(&a);
      lv_anim_set_var(&a, s);
      lv_anim_set_values(&a, x, x - 1320);  // one full screen-width left
      lv_anim_set_duration(&a, drift_ms);   // same for the whole layer → one parallax plane
      lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
      lv_anim_set_exec_cb(&a, [](void *v, int32_t xx) {
        lv_obj_set_x((lv_obj_t *) v, xx < -10 ? xx + 1320 : xx);  // wrap off-screen-left → right
      });
      lv_anim_start(&a);
    }
    if (tw && (i % 5 == 0)) twinkle(s, opa / 3, opa);
  }
}

// Layered night sky for 3D DEPTH via size + brightness (far tiny/dim → near big/bright).
// Stars are STATIC (drawn once = free); only a few twinkle. Drifting every star tanked the
// frame rate (too many scattered moving regions), so depth comes from the layers, not motion.
inline void stars(lv_obj_t *layer) {
  // Kept modest: each star is an object that gets re-composited whenever a cloud drifts
  // over it, so a big field made night/overcast scenes crawl. ~half the previous count.
  star_layer(layer, 30, 2, 0xCFE0FF, LV_OPA_40, 0, false);       // far — faint dust
  star_layer(layer, 14, 3, 0xE6EEFF, LV_OPA_70, 0, true);        // mid — some twinkle
  star_layer(layer, 6, 5, 0xFFFFFF, LV_OPA_COVER, 0, true);      // near — bright, twinkle
}

// Shooting stars: bright diagonal streaks that occasionally dart across the night sky.
// The streak is an angled line; position + opacity animate together (same cycle length so
// it's only visible while moving), with a long random gap so it stays a rare treat.
inline void shooting_stars(lv_obj_t *layer, int n) {
  static lv_point_precise_t pts[2] = {{0, 0}, {76, 26}};  // shared streak shape (relative)
  for (int i = 0; i < n; i++) {
    lv_obj_t *ln = lv_line_create(layer);
    lv_line_set_points(ln, pts, 2);
    lv_obj_set_style_line_width(ln, 3, 0);
    lv_obj_set_style_line_color(ln, lv_color_hex(0xFFFFFF), 0);
    lv_obj_set_style_line_rounded(ln, true, 0);
    lv_obj_remove_flag(ln, (lv_obj_flag_t) (LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE));
    lv_obj_set_pos(ln, rnd(120, 760), rnd(20, 120));
    lv_obj_set_style_opa(ln, LV_OPA_TRANSP, 0);
    uint32_t gap = (uint32_t) rnd(3500, 9000);
    lv_anim_t a; lv_anim_init(&a);                 // glide down-right
    lv_anim_set_var(&a, ln);
    lv_anim_set_values(&a, 0, 340);
    lv_anim_set_duration(&a, 720);
    lv_anim_set_delay(&a, (uint32_t) rnd(0, 6000));
    lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
    lv_anim_set_repeat_delay(&a, gap);
    lv_anim_set_exec_cb(&a, [](void *v, int32_t d) {
      lv_obj_set_style_translate_x((lv_obj_t *) v, d, 0);
      lv_obj_set_style_translate_y((lv_obj_t *) v, d * 26 / 76, 0);
    });
    lv_anim_start(&a);
    lv_anim_t o; lv_anim_init(&o);                  // fade in then out across the glide
    lv_anim_set_var(&o, ln);
    lv_anim_set_values(&o, 0, 255);
    lv_anim_set_duration(&o, 160);
    lv_anim_set_playback_duration(&o, 560);
    lv_anim_set_delay(&o, (uint32_t) rnd(0, 6000));
    lv_anim_set_repeat_count(&o, LV_ANIM_REPEAT_INFINITE);
    lv_anim_set_repeat_delay(&o, gap);
    lv_anim_set_exec_cb(&o, [](void *v, int32_t op) { lv_obj_set_style_opa((lv_obj_t *) v, (lv_opa_t) op, 0); });
    lv_anim_start(&o);
  }
}

// ── Character motion helpers (paths aren't just straight left→right) ────────────────
// Cross the screen in a RANDOM direction, reappearing after a gap, with an optional gentle
// vertical WAVE so the path curves. `wave` = peak vertical wander in px (0 = dead straight).
// Slide an object across the screen (repeating). `dir`: 0 = random, 1 = left→right,
// 2 = right→left. Directional sprites (heli, blimp, tractor…) must pin a direction so they
// don't fly/drive backwards; symmetric ones (balloon, kite, UFO) can stay random.
inline void cross_dir(lv_obj_t *o, int y, uint32_t dur, uint32_t delay, uint32_t gap, int wave, int dir) {
  bool ltr = (dir == 1) ? true : (dir == 2) ? false : (rnd(0, 1) == 0);
  lv_obj_set_y(o, y);
  lv_anim_t a; lv_anim_init(&a);
  lv_anim_set_var(&a, o);
  lv_anim_set_values(&a, ltr ? -300 : 1460, ltr ? 1460 : -300);
  lv_anim_set_duration(&a, dur);
  lv_anim_set_delay(&a, delay);
  lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
  lv_anim_set_repeat_delay(&a, gap);
  lv_anim_set_exec_cb(&a, [](void *v, int32_t x) { lv_obj_set_x((lv_obj_t *) v, x); });
  lv_anim_start(&a);
  if (wave) {
    lv_anim_t w; lv_anim_init(&w);
    lv_anim_set_var(&w, o);
    lv_anim_set_values(&w, -wave, wave);
    lv_anim_set_duration(&w, rnd(1500, 2800));
    lv_anim_set_playback_duration(&w, rnd(1500, 2800));
    lv_anim_set_repeat_count(&w, LV_ANIM_REPEAT_INFINITE);
    lv_anim_set_exec_cb(&w, [](void *v, int32_t ty) { lv_obj_set_style_translate_y((lv_obj_t *) v, ty, 0); });
    lv_anim_start(&w);
  }
}
inline void cross(lv_obj_t *o, int y, uint32_t dur, uint32_t delay, uint32_t gap, int wave) {
  cross_dir(o, y, dur, delay, gap, wave, 0);   // random direction (for symmetric sprites)
}

// Elliptical ORBIT — x and y oscillate a quarter-period apart, tracing a loop. Makes a
// character circle/loop in place instead of just passing through.
inline void orbit(lv_obj_t *o, int cx, int cy, int rx, int ry, uint32_t period) {
  lv_obj_set_pos(o, cx, cy);
  lv_anim_t ax; lv_anim_init(&ax);
  lv_anim_set_var(&ax, o);
  lv_anim_set_values(&ax, cx - rx, cx + rx);
  lv_anim_set_duration(&ax, period / 2);
  lv_anim_set_playback_duration(&ax, period / 2);
  lv_anim_set_repeat_count(&ax, LV_ANIM_REPEAT_INFINITE);
  lv_anim_set_path_cb(&ax, lv_anim_path_ease_in_out);
  lv_anim_set_exec_cb(&ax, [](void *v, int32_t x) { lv_obj_set_x((lv_obj_t *) v, x); });
  lv_anim_start(&ax);
  lv_anim_t ay; lv_anim_init(&ay);
  lv_anim_set_var(&ay, o);
  lv_anim_set_values(&ay, cy - ry, cy + ry);
  lv_anim_set_duration(&ay, period / 2);
  lv_anim_set_playback_duration(&ay, period / 2);
  lv_anim_set_delay(&ay, period / 4);   // quarter-phase → circular path
  lv_anim_set_repeat_count(&ay, LV_ANIM_REPEAT_INFINITE);
  lv_anim_set_path_cb(&ay, lv_anim_path_ease_in_out);
  lv_anim_set_exec_cb(&ay, [](void *v, int32_t y) { lv_obj_set_y((lv_obj_t *) v, y); });
  lv_anim_start(&ay);
}

// Characters take (delay, period): first appearance after `delay`, then once per `period`.
// The pickers stagger several so only ONE is on screen at a time, ~once a minute.
inline void ufo_abduct(lv_obj_t *layer, uint32_t delay, uint32_t period);   // fwd (cow set-piece)
inline void ufo(lv_obj_t *layer, uint32_t delay, uint32_t period) {
  if (rnd(0, 2) == 0) { ufo_abduct(layer, delay, period); return; }   // 1 in 3 → beam up a cow 🐄🛸
  uint32_t dur = rnd(15000, 19000);                      // medium, a touch faster than the satellite
  cross(spr(layer, 1, 162), 320, dur, delay, period - dur, rnd(24, 40));
}

// Sway an object back and forth along one axis forever (gentle wander).
inline void sway(lv_obj_t *o, bool xaxis, int a, int b, uint32_t dur, uint32_t delay) {
  lv_anim_t an; lv_anim_init(&an);
  lv_anim_set_var(&an, o);
  lv_anim_set_values(&an, a, b);
  lv_anim_set_duration(&an, dur);
  lv_anim_set_playback_duration(&an, dur);
  lv_anim_set_delay(&an, delay);
  lv_anim_set_repeat_count(&an, LV_ANIM_REPEAT_INFINITE);
  if (xaxis) lv_anim_set_exec_cb(&an, [](void *v, int32_t x) { lv_obj_set_x((lv_obj_t *) v, x); });
  else lv_anim_set_exec_cb(&an, [](void *v, int32_t y) { lv_obj_set_y((lv_obj_t *) v, y); });
  lv_anim_start(&an);
}

// Like sway(x-axis), but mirrors the sprite horizontally whenever it turns around, so it
// visibly faces the direction it's walking instead of sliding sideways. Art is assumed to
// face RIGHT by default (scale_x +256 = normal, -256 = mirrored) — flip the signs below if
// a given sprite sheet faces the other way. user_data stores the last x sample so the exec
// callback can tell which way the current tick is moving.
inline void walk_sway(lv_obj_t *o, int a, int b, uint32_t dur, uint32_t delay) {
  lv_obj_set_style_transform_pivot_x(o, lv_pct(50), 0);
  lv_obj_set_style_transform_pivot_y(o, lv_pct(50), 0);
  lv_obj_set_user_data(o, (void *) (intptr_t) a);
  lv_anim_t an; lv_anim_init(&an);
  lv_anim_set_var(&an, o);
  lv_anim_set_values(&an, a, b);
  lv_anim_set_duration(&an, dur);
  lv_anim_set_playback_duration(&an, dur);
  lv_anim_set_delay(&an, delay);
  lv_anim_set_repeat_count(&an, LV_ANIM_REPEAT_INFINITE);
  lv_anim_set_exec_cb(&an, [](void *v, int32_t x) {
    lv_obj_t *obj = (lv_obj_t *) v;
    intptr_t last = (intptr_t) lv_obj_get_user_data(obj);
    if (x != last) {
      lv_obj_set_style_transform_scale_x(obj, x < (int32_t) last ? -256 : 256, 0);
      lv_obj_set_user_data(obj, (void *) (intptr_t) x);
    }
    lv_obj_set_x(obj, x);
  });
  lv_anim_start(&an);
}

// Floating pollen / dust motes: tiny soft specks drifting and wandering (clear-day ambience).
inline void pollen(lv_obj_t *layer, int n) {
  for (int i = 0; i < n; i++) {
    int sz = rnd(6, 12);
    lv_obj_t *p = chip(layer, sz, sz, 0xFFF3BE, LV_OPA_COVER, LV_RADIUS_CIRCLE);
    int x = rnd(0, 1279), y = rnd(80, 540);
    lv_obj_set_pos(p, x, y);
    sway(p, true,  x - rnd(50, 130), x + rnd(50, 130), rnd(6000, 11000), rnd(0, 3000));
    sway(p, false, y - rnd(30, 80),  y + rnd(30, 80),  rnd(5000, 9000),  rnd(0, 3000));
    // (no twinkle — the extra per-frame opacity anim per mote isn't worth the redraw cost)
  }
}

// DAY cast — each in its OWN y-lane (no overlap with each other), all BELOW the sun.
inline void balloon(lv_obj_t *layer, uint32_t delay, uint32_t period) {   // lane 340 — slowest
  uint32_t dur = rnd(42000, 54000);   // lazy drift — a balloon shouldn't race across
  cross(spr(layer, 0, 130), 340, dur, delay, period - dur, 8);
}
inline void kite(lv_obj_t *layer, uint32_t delay, uint32_t period) {      // lane 425, long-tailed
  uint32_t dur = rnd(20000, 26000);
  cross(spr(layer, 2, 116), 425, dur, delay, period - dur, 16);
}
inline void airplane(lv_obj_t *layer, uint32_t delay, uint32_t period) {  // lane 248, banks as it flies
  lv_obj_t *p = spr(layer, 3, 150);
  lv_obj_set_y(p, 248);
  uint32_t dur = rnd(7500, 10500);                       // fastest — it's a jet
  lv_anim_t a; lv_anim_init(&a);
  lv_anim_set_var(&a, p);
  lv_anim_set_values(&a, -300, 1460);
  lv_anim_set_duration(&a, dur);
  lv_anim_set_delay(&a, delay);
  lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
  lv_anim_set_repeat_delay(&a, period - dur);
  lv_anim_set_exec_cb(&a, [](void *v, int32_t x) { lv_obj_set_x((lv_obj_t *) v, x); });
  lv_anim_start(&a);
  lv_anim_t bank; lv_anim_init(&bank);                  // slow roll weave through the half-frames
  lv_anim_set_var(&bank, p);
  lv_anim_set_values(&bank, 0, 3600);
  lv_anim_set_duration(&bank, 12000);
  lv_anim_set_repeat_count(&bank, LV_ANIM_REPEAT_INFINITE);
  lv_anim_set_exec_cb(&bank, plane_bank_exec);
  lv_anim_start(&bank);
}
inline void birds(lv_obj_t *layer, uint32_t delay, uint32_t period) {     // lane 296, a flock of gulls
  int n = rnd(2, 3);
  lv_obj_t *flock = lv_obj_create(layer);
  lv_obj_remove_style_all(flock); lv_obj_set_size(flock, 130, 44);
  lv_obj_remove_flag(flock, (lv_obj_flag_t) (LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE));
  for (int i = 0; i < n; i++) {
    lv_obj_t *bd = spr(flock, 4, rnd(120, 165));
    lv_obj_set_pos(bd, rnd(0, 120), rnd(0, 30));
    lv_anim_t f; lv_anim_init(&f);                       // staggered 2-frame wing flap
    lv_anim_set_var(&f, bd);
    lv_anim_set_values(&f, 0, 100);
    lv_anim_set_duration(&f, rnd(260, 420));
    lv_anim_set_playback_duration(&f, rnd(260, 420));
    lv_anim_set_delay(&f, rnd(0, 400));
    lv_anim_set_repeat_count(&f, LV_ANIM_REPEAT_INFINITE);
    lv_anim_set_exec_cb(&f, bird_flap_exec);
    lv_anim_start(&f);
  }
  uint32_t dur = rnd(12000, 16000);
  cross(flock, 296, dur, delay, period - dur, 10);
}

// NIGHT cast — satellite cruises the UPPER sky, the UFO works the lower lane.
inline void satellite(lv_obj_t *layer, uint32_t delay, uint32_t period) {
  lv_obj_t *s = spr(layer, 5, 175);
  int sy = rnd(60, 150); bool ltr = (rnd(0, 1) == 0);
  uint32_t dur = rnd(20000, 26000), gap = period - dur;  // slow, steady orbit pass
  lv_obj_set_pos(s, ltr ? -300 : 1460, sy);
  lv_anim_t a; lv_anim_init(&a);                       // steady straight diagonal pass
  lv_anim_set_var(&a, s);
  lv_anim_set_values(&a, ltr ? -300 : 1460, ltr ? 1460 : -300);
  lv_anim_set_duration(&a, dur); lv_anim_set_delay(&a, delay);
  lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE); lv_anim_set_repeat_delay(&a, gap);
  lv_anim_set_exec_cb(&a, [](void *v, int32_t x) { lv_obj_set_x((lv_obj_t *) v, x); });
  lv_anim_start(&a);
  lv_anim_t d; lv_anim_init(&d);
  lv_anim_set_var(&d, s);
  lv_anim_set_values(&d, sy, sy + (ltr ? 90 : -90));
  lv_anim_set_duration(&d, dur); lv_anim_set_delay(&d, delay);
  lv_anim_set_repeat_count(&d, LV_ANIM_REPEAT_INFINITE); lv_anim_set_repeat_delay(&d, gap);
  lv_anim_set_exec_cb(&d, [](void *v, int32_t y) { lv_obj_set_y((lv_obj_t *) v, y); });
  lv_anim_start(&d);
}

// UFO ABDUCTION: a saucer cruises slowly with a tractor beam, a cow bobbing up in it as
// if being reeled in. The whole rig is ONE group so it crosses (and repeats) as a unit.
inline void ufo_abduct(lv_obj_t *layer, uint32_t delay, uint32_t period) {
  lv_obj_t *grp = lv_obj_create(layer);
  lv_obj_remove_style_all(grp);
  lv_obj_set_size(grp, 150, 490);                     // tall: saucer up top → beam to the ground
  lv_obj_remove_flag(grp, (lv_obj_flag_t) (LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE));
  // Tapered light cone at 100% (no scaling cost): from just under the saucer down to the
  // ground. beam.png is 108×440 → spans the full drop; it fans out + fades toward the base.
  lv_obj_t *beam = spr(grp, 23, 256);
  lv_obj_set_style_image_opa(beam, LV_OPA_50, 0);
  lv_obj_set_pos(beam, 19, 34);
  twinkle(beam, 150, 210);                            // gentle beam shimmer
  lv_obj_t *u = spr(grp, 1, 176);                     // saucer on top of the beam
  lv_obj_set_pos(u, 38, 0);
  lv_obj_t *c = spr(grp, 20, 150);                    // cow lifting off the ground up the beam
  int cy = 402; lv_obj_set_pos(c, 52, cy);
  sway(c, false, cy - 46, cy + 8, 1900, 0);
  uint32_t dur = rnd(17000, 23000);                   // slow, majestic pass
  cross(grp, 100, dur, delay, period - dur, 0);       // top at y100 → base ~y590 (the ground)
}

// COMET (night): a bright head + tail streaking down across the sky, now and then.
inline void comet(lv_obj_t *layer, uint32_t delay, uint32_t period) {
  lv_obj_t *c = spr(layer, 21, rnd(150, 210));
  int y0 = rnd(20, 110);
  uint32_t dur = rnd(2400, 3400), gap = period - dur;   // fast streak, then gone for the period
  lv_obj_set_pos(c, 1360, y0);
  lv_anim_t a; lv_anim_init(&a); lv_anim_set_var(&a, c);
  lv_anim_set_values(&a, 1360, -240); lv_anim_set_duration(&a, dur); lv_anim_set_delay(&a, delay);
  lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE); lv_anim_set_repeat_delay(&a, gap);
  lv_anim_set_exec_cb(&a, [](void *v, int32_t x) { lv_obj_set_x((lv_obj_t *) v, x); });
  lv_anim_start(&a);
  lv_anim_t d; lv_anim_init(&d); lv_anim_set_var(&d, c);
  lv_anim_set_values(&d, y0, y0 + 240); lv_anim_set_duration(&d, dur); lv_anim_set_delay(&d, delay);
  lv_anim_set_repeat_count(&d, LV_ANIM_REPEAT_INFINITE); lv_anim_set_repeat_delay(&d, gap);
  lv_anim_set_exec_cb(&d, [](void *v, int32_t y) { lv_obj_set_y((lv_obj_t *) v, y); });
  lv_anim_start(&d);
}

// BLIMP (day): a stately airship drifting across, even slower than the balloon.
inline void blimp(lv_obj_t *layer, uint32_t delay, uint32_t period) {
  uint32_t dur = rnd(44000, 56000);
  cross_dir(spr(layer, 22, 150), 300, dur, delay, period - dur, 5, 2);   // faces LEFT → right→left
}

// HELICOPTER (night): crosses with a BLINKING red beacon on its belly.
inline void helicopter(lv_obj_t *layer, uint32_t delay, uint32_t period) {
  lv_obj_t *grp = lv_obj_create(layer);
  lv_obj_remove_style_all(grp);
  lv_obj_set_size(grp, 100, 44);
  lv_obj_remove_flag(grp, (lv_obj_flag_t) (LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE));
  spr(grp, 26, 150);                                    // heli body (top-left of the group)
  lv_obj_t *beacon = chip(grp, 6, 6, 0xFF3524, LV_OPA_COVER, LV_RADIUS_CIRCLE);
  lv_obj_set_pos(beacon, 22, 34);                       // belly light
  lv_anim_t bl; lv_anim_init(&bl); lv_anim_set_var(&bl, beacon);   // 1 Hz-ish blink
  lv_anim_set_values(&bl, 255, 0);
  lv_anim_set_duration(&bl, 260); lv_anim_set_playback_duration(&bl, 520);
  lv_anim_set_repeat_count(&bl, LV_ANIM_REPEAT_INFINITE);
  lv_anim_set_exec_cb(&bl, [](void *v, int32_t o) { lv_obj_set_style_bg_opa((lv_obj_t *) v, (lv_opa_t) o, 0); });
  lv_anim_start(&bl);
  uint32_t dur = rnd(9000, 13000);
  cross_dir(grp, 250, dur, delay, period - dur, 5, 2);   // faces LEFT → fly right→left
}

// ONE character on screen at a time, ~one per minute, cycling the cast in a RANDOM order
// (so it stays varied without ever being busy).
inline void day_characters(lv_obj_t *layer) {
  const uint32_t SLOT = 60000, PERIOD = 5 * SLOT;     // 5 acts → each every 5 min, 1/min
  void (*fns[5])(lv_obj_t *, uint32_t, uint32_t) = {balloon, birds, airplane, kite, blimp};
  int order[5] = {0, 1, 2, 3, 4};
  for (int i = 4; i > 0; i--) { int j = rnd(0, i); int t = order[i]; order[i] = order[j]; order[j] = t; }
  for (int i = 0; i < 5; i++) fns[order[i]](layer, (uint32_t) i * SLOT, PERIOD);
}
inline void night_characters(lv_obj_t *layer) {
  const uint32_t SLOT = 60000, PERIOD = 4 * SLOT;     // ufo(/abduction) + satellite + comet + heli
  void (*fns[4])(lv_obj_t *, uint32_t, uint32_t) = {ufo, satellite, comet, helicopter};
  int order[4] = {0, 1, 2, 3};
  for (int i = 3; i > 0; i--) { int j = rnd(0, i); int t = order[i]; order[i] = order[j]; order[j] = t; }
  for (int i = 0; i < 4; i++) fns[order[i]](layer, (uint32_t) i * SLOT, PERIOD);
}

// ── Seasonal / temperature ambience (added on top of the weather effect) ────────────
// Falling sprite particles (petals, leaves) that drift down and sway sideways.
inline void fall_sprites(lv_obj_t *layer, int idx, int n, uint32_t tmin, uint32_t tmax, int swayx) {
  for (int i = 0; i < n; i++) {
    lv_obj_t *p = spr(layer, idx, rnd(170, 256));
    int x = rnd(0, 1279);
    lv_obj_set_x(p, x);
    uint32_t dur = (uint32_t) rnd(tmin, tmax);
    anim_y(p, -24, 760, dur, rnd(0, (int) dur));
    sway(p, true, x - swayx, x + swayx, rnd(2200, 4000), rnd(0, 1500));
  }
}
inline void petals(lv_obj_t *layer) { fall_sprites(layer, 6, 10, 4200, 7000, rnd(40, 70)); }   // spring
inline void leaves(lv_obj_t *layer) { fall_sprites(layer, 7, 9, 4800, 8200, rnd(60, 120)); }   // autumn

// Fireflies: glowing yellow-green motes that wander slowly and blink (warm summer nights).
inline void fireflies(lv_obj_t *layer, int n) {
  for (int i = 0; i < n; i++) {
    int sz = rnd(4, 7);
    lv_obj_t *f = chip(layer, sz, sz, 0xCDF564, LV_OPA_COVER, LV_RADIUS_CIRCLE);
    int x = rnd(60, 1220), y = rnd(190, 500);
    lv_obj_set_pos(f, x, y);
    sway(f, true,  x - rnd(40, 110), x + rnd(40, 110), rnd(4000, 7000), rnd(0, 2500));
    sway(f, false, y - rnd(30, 70),  y + rnd(30, 70),  rnd(3500, 6000), rnd(0, 2500));
    twinkle(f, 0, 255);   // blink fully off→on
  }
}

// Heat shimmer: faint translucent bands rising near the ground when it's hot.
inline void heat_shimmer(lv_obj_t *layer) {
  for (int i = 0; i < 6; i++) {
    int w = rnd(180, 360), y = rnd(380, 500);
    lv_obj_t *b = chip(layer, w, rnd(8, 16), 0xFFFFFF, LV_OPA_20, 8);
    lv_obj_set_pos(b, rnd(0, 1100), y);
    uint32_t dur = (uint32_t) rnd(2600, 4600);
    lv_anim_t a; lv_anim_init(&a);                 // rise + fade
    lv_anim_set_var(&a, b);
    lv_anim_set_values(&a, y, y - rnd(20, 40));
    lv_anim_set_duration(&a, dur);
    lv_anim_set_delay(&a, rnd(0, 2500));
    lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
    lv_anim_set_exec_cb(&a, [](void *v, int32_t yy) { lv_obj_set_y((lv_obj_t *) v, yy); });
    lv_anim_start(&a);
    lv_anim_t o; lv_anim_init(&o);
    lv_anim_set_var(&o, b);
    lv_anim_set_values(&o, 0, 50);
    lv_anim_set_duration(&o, dur / 2);
    lv_anim_set_playback_duration(&o, dur / 2);
    lv_anim_set_delay(&o, rnd(0, 2500));
    lv_anim_set_repeat_count(&o, LV_ANIM_REPEAT_INFINITE);
    lv_anim_set_exec_cb(&o, [](void *v, int32_t op) { lv_obj_set_style_bg_opa((lv_obj_t *) v, (lv_opa_t) op, 0); });
    lv_anim_start(&o);
  }
}

// Layer seasonal/temperature ambience on top of the weather scene. month: 1-12, temp °F.
inline void apply_seasonal(lv_obj_t *layer, int code, bool day, int month, int temp) {
  if (!layer) return;
  bool clearish = (code <= 2);              // clear / mainly clear / partly cloudy
  (void) temp;                              // (heat shimmer removed — it just read as streaks)
  if (clearish && day) {
    if (month >= 3 && month <= 5)  petals(layer);   // spring
    if (month >= 9 && month <= 11) leaves(layer);   // autumn
  }
  if (clearish && !day && month >= 6 && month <= 8 && temp >= 58) fireflies(layer, 7);  // summer nights
}

// Material Symbols glyph (UTF-8) for a WMO code (+ day/night). Codepoints must match the
// `font_weather_icons` glyph set in the YAML.
inline const char *icon_for(int code, bool day) {
  if (code == 0)       return day ? "\U0000F157" : "\U0000F159";  // clear → sun / moon
  if (code <= 2)       return day ? "\U0000F172" : "\U0000F174";  // partly cloudy
  if (code == 3)       return "\U0000F15C";                       // overcast → cloud
  if (code <= 48)      return "\U0000E818";                       // fog
  if (code <= 67)      return "\U0000F176";                       // drizzle/rain
  if (code <= 77)      return "\U0000E2CD";                       // snow
  if (code <= 82)      return "\U0000F176";                       // rain showers
  if (code <= 86)      return "\U0000E2CD";                       // snow showers
  return "\U0000EBDB";                                            // thunderstorm
}

// ── Background gradient selection (mirrors the web app's wmoInfo gradient mapping) ──
// Returns an index into the 16 baked gradient strips, ordered:
//   0/1 clear, 2/3 partly, 4/5 cloudy, 6/7 fog, 8/9 drizzle, 10/11 rain, 12/13 snow,
//   14/15 storm  — within each pair, [day, night].
inline int gradient_key(int code, bool day) {
  int g;                                   // 0 clear..7 storm
  if (code <= 1)        g = 0;             // clear / mainly clear
  else if (code == 2)   g = 1;             // partly cloudy
  else if (code == 3)   g = 2;             // overcast
  else if (code <= 48)  g = 3;             // fog
  else if (code <= 53)  g = 4;             // drizzle (51,53)
  else if (code <= 67)  g = 5;             // heavy drizzle + rain
  else if (code <= 77)  g = 6;             // snow
  else if (code <= 82)  g = 5;             // rain showers
  else if (code <= 86)  g = 6;             // snow showers
  else                  g = 7;             // thunderstorm
  return g * 2 + (day ? 0 : 1);
}

// The 16 baked gradient-strip image descriptors, filled once at startup from the YAML.
inline const lv_image_dsc_t **bg_table() { static const lv_image_dsc_t *t[16] = {}; return t; }
inline void set_bg(lv_obj_t *bg_img, int key) {
  const lv_image_dsc_t **t = bg_table();
  if (bg_img && key >= 0 && key < 16 && t[key]) lv_image_set_src(bg_img, t[key]);
}

// The sun-rays image descriptor (filled once at startup), used by the clear-day scene + icon.
inline const lv_image_dsc_t *&sun_dsc() { static const lv_image_dsc_t *d = nullptr; return d; }

// The current background sun image (or null), rotated in low-rate STEPS by tick_sun().
// Per-frame image rotation was too heavy on this panel (no PPA accel) → choppy; stepping
// it ~20×/s instead of every frame, on a smaller sun, is smooth and cheap.
inline lv_obj_t *&sun_obj() { static lv_obj_t *o = nullptr; return o; }
// The sun is now a clean glowing ORB (no rays) — like the reference cards — so there's
// nothing to spin. tick_sun() is kept (the YAML interval calls it) but is a no-op.
inline void tick_sun() {}

// Rising sparkles that drift up and fade (the clear-day shimmer).
inline void sparkles(lv_obj_t *layer, int n) {
  for (int i = 0; i < n; i++) {
    int sz = rnd(5, 9);
    lv_obj_t *s = chip(layer, sz, sz, 0xFFF6C8, LV_OPA_COVER, LV_RADIUS_CIRCLE);
    int x = rnd(120, 1160), y = rnd(80, 380);
    lv_obj_set_pos(s, x, y);
    uint32_t dur = (uint32_t) rnd(2200, 4200);
    lv_anim_t a; lv_anim_init(&a);                    // rise
    lv_anim_set_var(&a, s);
    lv_anim_set_values(&a, y, y - rnd(40, 90));
    lv_anim_set_duration(&a, dur);
    lv_anim_set_delay(&a, rnd(0, 2500));
    lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
    lv_anim_set_exec_cb(&a, [](void *v, int32_t yy) { lv_obj_set_y((lv_obj_t *) v, yy); });
    lv_anim_start(&a);
    lv_anim_t o; lv_anim_init(&o);                    // fade in/out
    lv_anim_set_var(&o, s);
    lv_anim_set_values(&o, 0, 220);
    lv_anim_set_duration(&o, dur / 2);
    lv_anim_set_playback_duration(&o, dur / 2);
    lv_anim_set_delay(&o, rnd(0, 2500));
    lv_anim_set_repeat_count(&o, LV_ANIM_REPEAT_INFINITE);
    lv_anim_set_exec_cb(&o, [](void *v, int32_t op) { lv_obj_set_style_bg_opa((lv_obj_t *) v, (lv_opa_t) op, 0); });
    lv_anim_start(&o);
  }
}

// Place the glowing sun ORB in the open sky between the clock and the weather card.
inline void place_sun(lv_obj_t *layer, uint8_t scale) {
  if (!sun_dsc()) return;
  lv_obj_t *sun = lv_image_create(layer);
  lv_image_set_src(sun, sun_dsc());
  lv_image_set_scale(sun, scale);                 // /256 fixed-point on the orb art
  lv_obj_align(sun, LV_ALIGN_TOP_MID, 135, 2);    // in the open sky gap between clock and card
  lv_obj_remove_flag(sun, (lv_obj_flag_t) (LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE));
  sun_obj() = sun;                                // also used to keep characters from overlapping it
}

// A pale moon (the warm orb recolored cool) for clear nights.
inline void place_moon(lv_obj_t *layer) {
  if (!sun_dsc()) return;
  lv_obj_t *m = lv_image_create(layer);
  lv_image_set_src(m, sun_dsc());
  lv_image_set_scale(m, 104);                     // smaller than the sun
  lv_obj_set_style_image_recolor_opa(m, LV_OPA_50, 0);
  lv_obj_set_style_image_recolor(m, lv_color_hex(0xB4C7EA), 0);   // cool moonlight tint
  lv_obj_align(m, LV_ALIGN_TOP_MID, 135, 4);
  lv_obj_remove_flag(m, (lv_obj_flag_t) (LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE));
  sun_obj() = m;
}

// Clear-DAY scene: a big sun (rays slowly rotating) up top + rising sparkles.
inline void sun_scene(lv_obj_t *layer) {
  // Clear day = clear sky. No drifting clouds here (those belong to cloudy weather).
  // Particle counts kept LOW: every animated mote = a per-frame invalidate that gets
  // software-rotated + flushed, so a big swarm is what makes motion choppy on this panel.
  place_sun(layer, 152);
  sparkles(layer, 3);
  pollen(layer, 4);          // floating motes (characters are added at the dispatch level)
}

// ── Terrain: layered hill silhouettes receding into haze (the base of every scene) ──
// Big circles parked mostly below the screen so only a gentle dome shows; two layers in
// atmospheric perspective (back lighter/hazier, front darker) read as rolling hills.
inline lv_obj_t *hill(lv_obj_t *layer, int diam, int cx, int top_y, uint32_t col) {
  lv_obj_t *o = lv_obj_create(layer);
  lv_obj_remove_style_all(o);
  lv_obj_set_size(o, diam, diam);
  lv_obj_set_style_radius(o, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_bg_color(o, lv_color_hex(col), 0);
  lv_obj_set_style_bg_opa(o, LV_OPA_COVER, 0);
  lv_obj_set_pos(o, cx - diam / 2, top_y);
  lv_obj_remove_flag(o, (lv_obj_flag_t) (LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE));
  return o;
}
struct HillPal { uint32_t back, front, tree; };
inline HillPal hill_palette(int code, bool day) {
  if (!day) return (HillPal){ 0x18213C, 0x0C1430, 0x070C1F };   // night → dark hazy silhouettes
  int g = (code <= 1) ? 0 : (code == 2) ? 1 : (code == 3) ? 2 : (code <= 48) ? 3 :
          (code <= 67) ? 4 : (code <= 77) ? 5 : (code <= 82) ? 4 : (code <= 86) ? 5 : 6;
  switch (g) {
    case 0:  return (HillPal){ 0x9AC6E2, 0x3A8A64, 0x215E46 };   // clear — pale-blue ridge + green grass
    case 1:  return (HillPal){ 0x4A86C0, 0x356F8C, 0x244E63 };   // partly cloudy
    case 2:  return (HillPal){ 0x3D4A5E, 0x28323F, 0x1A2530 };   // overcast — slate
    case 3:  return (HillPal){ 0x7A828E, 0x5A616C, 0x474D57 };   // fog — pale grey, low contrast
    case 4:  return (HillPal){ 0x2B3A56, 0x16213A, 0x101A2E };   // rain — deep blue-grey
    case 5:  return (HillPal){ 0xC6D4E4, 0xAFBFD2, 0x4A7A60 };   // snow — pale, dark-green pines
    default: return (HillPal){ 0x1A2340, 0x0E1430, 0x080C20 };   // storm — near-black
  }
}
// Build the terrain (drawn first, under the weather particles).
inline void landscape(lv_obj_t *layer, int code, bool day) {
  HillPal p = hill_palette(code, day);
  const uint32_t NT = 0x141D33; const lv_opa_t NO = LV_OPA_70;
  auto dusk = [&](lv_obj_t *o) {
    if (!day) { lv_obj_set_style_image_recolor_opa(o, NO, 0); lv_obj_set_style_image_recolor(o, lv_color_hex(NT), 0); }
  };

  hill(layer, 2200, 470, 498, p.back);      // BACK ridge (hazier, higher crest)

  // ── FAR field — drawn BEFORE the front ridge so the near hill OCCLUDES it (real depth):
  // a distant home on the far crest, and a tractor that crosses the back ridge and slips
  // BEHIND the front hill mid-screen instead of driving over it. Small + hazy = distance.
  {
    bool left = rnd(0, 1);
    int hx = left ? rnd(150, 330) : rnd(1000, 1140);
    int hd = hx - 470, hdrop = hd * hd / 2100;
    bool isBarn = rnd(0, 1);
    lv_obj_t *hm = spr(layer, isBarn ? 25 : 27, 104);             // smaller = further away
    int hh = (isBarn ? 86 : 70) * 104 / 256;
    lv_obj_set_pos(hm, hx, 498 + hdrop - hh + 4);
    if (day) lv_obj_set_style_image_opa(hm, 230, 0);             // atmospheric haze
    dusk(hm);
  }
  if (rnd(0, 1) == 0) {                       // tractor on the far ridge — a slow crawl; the
    lv_obj_t *tr = spr(layer, 24, 118);       // front hill hides it as it passes behind
    lv_obj_set_y(tr, 556);                    // low enough that the front dome covers it mid-screen
    dusk(tr);
    anim_x(tr, -150, 1400, rnd(110000, 155000), rnd(4000, 22000));  // ~2-2.5 min to cross
  }

  hill(layer, 2700, 820, 548, p.front);     // FRONT ridge — covers whatever far-field it overlaps

  // Pines on the NEAR ridge (front dome: cx820, crest548, r≈1350).
  int n = rnd(3, 5);
  for (int i = 0; i < n; i++) {
    int sc = rnd(120, 210), hgt = 96 * sc / 256, x = rnd(540, 880);
    int dx = x - 820, drop = dx * dx / 2700;
    lv_obj_t *t = spr(layer, 14, sc);
    lv_obj_set_style_image_recolor_opa(t, LV_OPA_COVER, 0);
    lv_obj_set_style_image_recolor(t, lv_color_hex(p.tree), 0);
    lv_obj_set_pos(t, x, 548 + drop - hgt + 2);
  }
  // Cows grazing on the NEAR ridge (in front of everything, bigger). They take a few slow
  // steps left/right as they graze, mirroring to face whichever way they're currently
  // walking (walk_sway), plus a quick head-bob.
  int cows = rnd(1, 2);
  for (int i = 0; i < cows; i++) {
    int cx2 = rnd(360, 900), cd = cx2 - 820, cdrop = cd * cd / 2700;
    int cyy = 548 + cdrop - (48 * 132 / 256) + 2;
    lv_obj_t *cw = spr(layer, 20, 132);
    lv_obj_set_pos(cw, cx2, cyy);
    dusk(cw);
    sway(cw, false, cyy, cyy + 3, rnd(2600, 3800), rnd(0, 1500));  // gentle graze bob
    int stride = rnd(18, 34);
    walk_sway(cw, cx2 - stride, cx2 + stride, rnd(9000, 14000), rnd(0, 4000));  // slow graze walk
  }
}

// Partly-cloudy: a few clouds hovering/drifting IN FRONT OF THE SUN (gentle horizontal
// sway around the sun's spot) rather than scattered all over the sky.
inline void sun_clouds(lv_obj_t *layer, bool day) {
  int n = rnd(2, 3);
  for (int i = 0; i < n; i++) {
    int scale = rnd(180, 270);
    lv_obj_t *c = spr(layer, 13, scale);
    lv_obj_set_style_image_opa(c, day ? rnd(160, 205) : rnd(110, 150), 0);
    if (!day) lv_obj_set_style_image_recolor_opa(c, LV_OPA_50, 0),
              lv_obj_set_style_image_recolor(c, lv_color_hex(0x39435A), 0);
    int x = rnd(560, 940), y = rnd(6, 116);
    lv_obj_set_pos(c, x, y);
    sway(c, true, x - rnd(130, 230), x + rnd(130, 230), rnd(15000, 23000), rnd(0, 6000));
  }
}

// ── Dispatch: build the right effect for a WMO code (+ day/night) ───────────────────
inline void apply_weather_fx(lv_obj_t *layer, int code, bool day) {
  if (!layer) return;
  sun_obj() = nullptr;  // the old sun (if any) is about to be destroyed by clean()
  lv_obj_clean(layer);  // drop previous particles + their animations
  landscape(layer, code, day);  // terrain is the base of EVERY scene
  if (code <= 1) {                       // clear / mainly clear
    if (day) sun_scene(layer);
    else { stars(layer); shooting_stars(layer, 2); place_moon(layer); }
  } else if (code <= 3) {                // partly cloudy / overcast
    if (!day && code < 3) stars(layer);  // stars peek through PARTLY cloud at night; overcast hides them
    if (code == 2 && day) {              // partly cloudy DAY: sun with a few clouds drifting in front
      place_sun(layer, 130);
      sun_clouds(layer, true);
    } else {                             // overcast (or night) — broader cover, no sun
      clouds(layer, code == 3 ? 3 : 2, day ? 172 : 150, day);
    }
  } else if (code <= 48) {               // fog / haze
    fog(layer);
  } else if (code <= 57) {               // drizzle
    rain(layer, 12, 24, 0x9DB9E0);
  } else if (code <= 67) {               // rain
    rain(layer, 18, 50, 0x9DB9E0);
  } else if (code <= 77) {               // snow
    snow(layer, 20);
  } else if (code <= 82) {               // rain showers
    rain(layer, 22, 80, 0x9DB9E0);
  } else if (code <= 86) {               // snow showers
    snow(layer, 22);
  } else {                               // thunderstorm
    rain(layer, 18, 60, 0xB8C6E6);
    lightning(layer);
  }
  // Characters fly on NICE weather only (clear / partly / cloudy) — not in rain/snow/storm/fog.
  if (code <= 3) { if (day) day_characters(layer); else night_characters(layer); }
}

// ── Card icon: rotating sun image for clear day, font glyph (with bob) otherwise ──────
inline void set_card_icon(lv_obj_t *glyph, lv_obj_t *img, int code, bool day) {
  lv_anim_delete(glyph, nullptr);
  lv_obj_add_flag(img, LV_OBJ_FLAG_HIDDEN);   // (legacy rotating-image path removed — too heavy)
  lv_obj_clear_flag(glyph, LV_OBJ_FLAG_HIDDEN);
  lv_label_set_text(glyph, icon_for(code, day));
  lv_obj_set_style_text_opa(glyph, LV_OPA_COVER, 0);
  lv_anim_t a; lv_anim_init(&a);
  lv_anim_set_var(&a, glyph);
  lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
  if (code <= 1 && day) {                     // sun glyph: soft glow pulse
    lv_anim_set_values(&a, 150, 255);
    lv_anim_set_duration(&a, 1700);
    lv_anim_set_playback_duration(&a, 1700);
    lv_anim_set_exec_cb(&a, [](void *v, int32_t o) { lv_obj_set_style_text_opa((lv_obj_t *) v, (lv_opa_t) o, 0); });
  } else {                                    // everything else: gentle bob
    lv_anim_set_values(&a, -6, 6);
    lv_anim_set_duration(&a, 2400);
    lv_anim_set_playback_duration(&a, 2400);
    lv_anim_set_exec_cb(&a, [](void *v, int32_t y) { lv_obj_set_style_translate_y((lv_obj_t *) v, y, 0); });
  }
  lv_anim_start(&a);
}

// ── Card icon motion ────────────────────────────────────────────────────────────────
inline void animate_weather_icon(lv_obj_t *icon, int code, bool day) {
  if (!icon) return;
  lv_anim_delete(icon, nullptr);
  lv_obj_set_style_translate_y(icon, 0, 0);
  if (code <= 1 && day) {
    // Sun: a soft "breathing" glow (opacity pulse) — labels can't rotate, so no spin.
    lv_anim_t a; lv_anim_init(&a);
    lv_anim_set_var(&a, icon);
    lv_anim_set_values(&a, 150, 255);
    lv_anim_set_duration(&a, 1600);
    lv_anim_set_playback_duration(&a, 1600);
    lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
    lv_anim_set_exec_cb(&a, [](void *v, int32_t o) { lv_obj_set_style_text_opa((lv_obj_t *) v, (lv_opa_t) o, 0); });
    lv_anim_start(&a);
  } else {
    // Everything else: a gentle vertical bob.
    lv_obj_set_style_text_opa(icon, LV_OPA_COVER, 0);
    lv_anim_t a; lv_anim_init(&a);
    lv_anim_set_var(&a, icon);
    lv_anim_set_values(&a, -6, 6);
    lv_anim_set_duration(&a, 2400);
    lv_anim_set_playback_duration(&a, 2400);
    lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
    lv_anim_set_exec_cb(&a, [](void *v, int32_t y) { lv_obj_set_style_translate_y((lv_obj_t *) v, y, 0); });
    lv_anim_start(&a);
  }
}

}  // namespace wxfx
#endif  // USE_LVGL
