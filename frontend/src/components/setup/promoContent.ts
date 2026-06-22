// Content for the install-screen promo - a rotating hero showcase of what the
// app can do, plus a separate ticker of bite-sized "Did you know?" usage tips.
// Kept as data so copy is easy to edit without touching the component.

import type { LucideIcon } from 'lucide-react'
import {
  Sparkles, Brain, Wand2, Palette, ImagePlus, Mic, Eye, Film, CloudSun,
  BookOpen, Globe, GraduationCap, Wrench, Stethoscope, Map, Newspaper, Boxes,
  Home, Lock, Users, WifiOff,
} from 'lucide-react'

export interface PromoSlide {
  Icon: LucideIcon
  gradient: string
  app: string       // which app/section this lives in (shown as an eyebrow label)
  headline: string
  blurb: string
}

// Order roughly follows the journey: meet the AI, create, talk, see, then the
// offline library, your day, your home, your family, and the privacy promise.
export const PROMO_SLIDES: PromoSlide[] = [
  {
    Icon: Sparkles,
    gradient: 'linear-gradient(135deg,#8b5cf6,#6366f1)',
    app: 'Companion',
    headline: 'Meet your companion',
    blurb: 'A friendly AI that floats on every page - it sees, speaks, and remembers what matters to you.',
  },
  {
    Icon: Brain,
    gradient: 'linear-gradient(135deg,#6366f1,#3b82f6)',
    app: 'Chat',
    headline: 'Conversations that remember you',
    blurb: 'In Chat, each character builds a lasting memory of your life, so you never have to repeat yourself.',
  },
  {
    Icon: Wand2,
    gradient: 'linear-gradient(135deg,#ec4899,#8b5cf6)',
    app: 'Images',
    headline: 'Create images from words',
    blurb: 'In the Images app, describe anything and generate it right here - portraits, landscapes, logos, wallpapers, all on your own machine.',
  },
  {
    Icon: Palette,
    gradient: 'linear-gradient(135deg,#f43f5e,#ec4899)',
    app: 'Images',
    headline: 'Any style you can imagine',
    blurb: 'A 1950s diner, a Saturday-morning cartoon, an oil painting, a vaporwave city - name the look in the Images app and your picture wears it.',
  },
  {
    Icon: ImagePlus,
    gradient: 'linear-gradient(135deg,#8b5cf6,#d946ef)',
    app: 'Images',
    headline: 'Restore and enhance photos',
    blurb: 'The Images app can sharpen, upscale, and breathe new life into old, blurry, or low-resolution pictures.',
  },
  {
    Icon: Film,
    gradient: 'linear-gradient(135deg,#f97316,#ec4899)',
    app: 'Video',
    headline: 'Make it move',
    blurb: 'The Video app turns a prompt or a single still photo into a short, smooth animated clip.',
  },
  {
    Icon: Mic,
    gradient: 'linear-gradient(135deg,#06b6d4,#3b82f6)',
    app: 'Voice',
    headline: 'Talk, hands-free',
    blurb: 'Say your wake word and just speak. Replies come back in a natural voice, read aloud.',
  },
  {
    Icon: Eye,
    gradient: 'linear-gradient(135deg,#14b8a6,#06b6d4)',
    app: 'Chat',
    headline: 'Show it anything',
    blurb: 'Attach a photo in Chat and your AI understands it - identify objects, read labels, translate menus, answer questions.',
  },
  {
    Icon: CloudSun,
    gradient: 'linear-gradient(135deg,#f59e0b,#3b82f6)',
    app: 'Weather',
    headline: 'Knows when you need a jacket',
    blurb: 'The Weather app and your companion read the local forecast and remind you to grab an umbrella, sunglasses, or a coat before you head out.',
  },
  {
    Icon: BookOpen,
    gradient: 'linear-gradient(135deg,#22c55e,#14b8a6)',
    app: 'Offline Library',
    headline: 'Your library, no signal needed',
    blurb: 'The Offline Library downloads a shelf of knowledge once and lets you read it forever - it works when nothing else does.',
  },
  {
    Icon: Globe,
    gradient: 'linear-gradient(135deg,#3b82f6,#22c55e)',
    app: 'Offline Library',
    headline: 'All of Wikipedia, offline',
    blurb: 'Millions of articles in the Offline Library, ready the moment you ask - no connection, no waiting.',
  },
  {
    Icon: GraduationCap,
    gradient: 'linear-gradient(135deg,#6366f1,#06b6d4)',
    app: 'Offline Library',
    headline: 'Learn anything, anywhere',
    blurb: 'Full Khan Academy and Crash Course lessons in the Offline Library - math, science, and history, watched and read with zero signal.',
  },
  {
    Icon: Wrench,
    gradient: 'linear-gradient(135deg,#64748b,#f97316)',
    app: 'Offline Library',
    headline: 'Fix it yourself',
    blurb: 'iFixit repair guides in the Offline Library walk you through phones, appliances, and cars step by step, even off the grid.',
  },
  {
    Icon: Stethoscope,
    gradient: 'linear-gradient(135deg,#ef4444,#ec4899)',
    app: 'Offline Library',
    headline: 'First-aid and medical references on hand',
    blurb: 'Trusted health and emergency guides in the Offline Library stay available when you need them most, online or off.',
  },
  {
    Icon: Map,
    gradient: 'linear-gradient(135deg,#10b981,#22c55e)',
    app: 'Maps',
    headline: 'Maps that work offline',
    blurb: 'The Maps app searches places and gives turn-by-turn directions with no signal, once you have downloaded your region.',
  },
  {
    Icon: Newspaper,
    gradient: 'linear-gradient(135deg,#3b82f6,#6366f1)',
    app: 'Today & News',
    headline: 'Your whole day at a glance',
    blurb: 'On the Home screen: news, weather, sports, and "on this day" - a warm daily briefing your companion weaves in naturally.',
  },
  {
    Icon: Boxes,
    gradient: 'linear-gradient(135deg,#f59e0b,#f97316)',
    app: 'Home Inventory',
    headline: 'Track everything you own',
    blurb: 'In Home Inventory, snap a photo of a device and your AI identifies it, files the manual, and watches your warranties for you.',
  },
  {
    Icon: Home,
    gradient: 'linear-gradient(135deg,#0ea5e9,#8b5cf6)',
    app: 'Smart Home',
    headline: 'Run your home by voice',
    blurb: 'Connect your smart home and just ask your companion - dim the lights, lock the doors, set the temperature.',
  },
  {
    Icon: Lock,
    gradient: 'linear-gradient(135deg,#22c55e,#0ea5e9)',
    app: 'Parental Controls',
    headline: 'Safe for kids, by design',
    blurb: 'Per-profile content ratings, blocked words, and PIN-locked profiles keep younger family members in bounds.',
  },
  {
    Icon: Users,
    gradient: 'linear-gradient(135deg,#8b5cf6,#ec4899)',
    app: 'Profiles',
    headline: 'Built for the whole family',
    blurb: 'Netflix-style profiles, each with its own memories, history, companion, and a PIN to keep things private.',
  },
  {
    Icon: WifiOff,
    gradient: 'linear-gradient(135deg,#10b981,#3b82f6)',
    app: '100% Local',
    headline: 'Pull the plug. It still works.',
    blurb: 'Every model, map, and archive runs on this machine. No cloud, no subscription, no internet required - ever.',
  },
]

// Short, learnable tips - rotate independently of the hero, on a faster timer.
export const PROMO_TIPS: string[] = [
  'Press ⌘K to search anything instantly.',
  '⌘⇧P toggles Privacy mode in a flash.',
  'Pin your favorite apps in the sidebar for one-tap access.',
  'Say your wake word to start talking hands-free.',
  'Attach a photo in chat and your AI will describe it.',
  'Each profile keeps its own memories and chat history.',
  'Ask for an image "in the style of" any era, artist, or cartoon.',
  'Turn a single photo into a short animated clip in the Video app.',
  'Download a map region once - it works forever offline.',
  'Your companion floats on every page; click it to chat anywhere.',
  'Set a content rating and blocked words per profile in Settings.',
  'Browse all of Wikipedia with no internet from the Offline Library.',
  'Khan Academy and Crash Course are available offline - grab them from Admin → Features → Library.',
  'iFixit repair guides are offline-ready so you can fix things without a connection.',
  'Connect your smart home and control the lights and locks just by asking.',
  'You can disconnect from the internet entirely - maps, library, and AI keep working.',
]
