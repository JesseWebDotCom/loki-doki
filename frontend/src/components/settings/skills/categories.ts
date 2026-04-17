/**
 * Category derivation for skills.
 *
 * Capabilities use descriptive names like `get_weather` and
 * `lookup_movie`. We derive categories from explicit mappings
 * and keyword patterns.
 */
import {
  Wrench,
  Cloud,
  Film,
  Newspaper,
  BookOpen,
  Calculator,
  Search,
  Home,
  Smile,
  Utensils,
  Tv,
  Clock,
  Heart,
  Music,
  MessageSquare,
  MapPin,
  Plane,
  TrendingUp,
  Bell,
  Dumbbell,
  type LucideIcon,
} from "lucide-react";

export interface CategoryMeta {
  label: string;
  Icon: LucideIcon;
}

/** Explicit capability → category mapping. */
const ID_TO_CATEGORY: Record<string, string> = {
  // Weather
  get_weather: "weather",
  // Entertainment — movies
  lookup_movie: "entertainment",
  search_movies: "entertainment",
  get_movie_showtimes: "entertainment",
  recall_recent_media: "entertainment",
  // Entertainment — TV
  lookup_tv_show: "entertainment",
  get_tv_schedule: "entertainment",
  get_episode_detail: "entertainment",
  // Entertainment — music
  lookup_track: "music",
  play_music: "music",
  control_playback: "music",
  get_now_playing: "music",
  set_volume: "music",
  get_music_video: "music",
  // Entertainment — YouTube
  get_video: "entertainment",
  get_youtube_channel: "entertainment",
  // News
  get_news_headlines: "news",
  search_news: "news",
  get_briefing: "news",
  // Reference / knowledge
  knowledge_query: "reference",
  lookup_definition: "reference",
  lookup_fact: "reference",
  spell_word: "reference",
  translate: "reference",
  lookup_person_birthday: "reference",
  // Math / conversion
  calculate: "math",
  calculate_tip: "math",
  convert_units: "math",
  convert_currency: "math",
  get_exchange_rate: "math",
  // Search
  search_web: "search",
  // Smart home
  control_device: "smart_home",
  get_device_state: "smart_home",
  get_indoor_temperature: "smart_home",
  set_scene: "smart_home",
  detect_presence: "smart_home",
  // Food
  get_nutrition: "food",
  find_recipe: "food",
  substitute_ingredient: "food",
  order_food: "food",
  // Fun
  tell_joke: "fun",
  emotional_support: "fun",
  weigh_options: "fun",
  // Utilities / time
  get_current_time: "utilities",
  get_current_date: "utilities",
  get_time_in_location: "utilities",
  get_holiday: "utilities",
  list_holidays: "utilities",
  time_until: "utilities",
  set_alarm: "utilities",
  list_alarms: "utilities",
  cancel_alarm: "utilities",
  set_timer: "utilities",
  set_reminder: "utilities",
  // Communication
  send_text_message: "communication",
  make_call: "communication",
  read_messages: "communication",
  read_emails: "communication",
  search_contacts: "communication",
  generate_email: "communication",
  // Navigation / travel
  get_directions: "travel",
  get_eta: "travel",
  find_nearby: "travel",
  get_transit: "travel",
  search_flights: "travel",
  get_flight_status: "travel",
  search_hotels: "travel",
  get_visa_info: "travel",
  // Finance
  get_stock_price: "finance",
  get_stock_info: "finance",
  // Health / fitness
  look_up_symptom: "health",
  check_medication: "health",
  get_fitness_summary: "health",
  log_workout: "health",
  // Productivity
  create_event: "productivity",
  get_events: "productivity",
  get_schedule: "productivity",
  delete_event: "productivity",
  update_event: "productivity",
  create_note: "productivity",
  search_notes: "productivity",
  create_plan: "productivity",
  append_to_list: "productivity",
  read_list: "productivity",
  summarize_text: "productivity",
  // Shopping
  find_products: "shopping",
  get_streaming: "shopping",
  // Chat / LLM
  direct_chat: "chat",
  code_assistance: "chat",
  // People
  lookup_relationship: "people",
  list_family: "people",
  // Sports
  get_score: "sports",
  get_standings: "sports",
  get_player_stats: "sports",
};

export const CATEGORIES: Record<string, CategoryMeta> = {
  weather: { label: "Weather", Icon: Cloud },
  entertainment: { label: "Entertainment", Icon: Film },
  music: { label: "Music", Icon: Music },
  news: { label: "News", Icon: Newspaper },
  reference: { label: "Reference", Icon: BookOpen },
  math: { label: "Math & Conversions", Icon: Calculator },
  search: { label: "Search", Icon: Search },
  smart_home: { label: "Smart Home", Icon: Home },
  fun: { label: "Fun", Icon: Smile },
  food: { label: "Food & Cooking", Icon: Utensils },
  utilities: { label: "Time & Utilities", Icon: Clock },
  communication: { label: "Communication", Icon: MessageSquare },
  travel: { label: "Travel & Navigation", Icon: Plane },
  finance: { label: "Finance", Icon: TrendingUp },
  health: { label: "Health & Fitness", Icon: Dumbbell },
  productivity: { label: "Productivity", Icon: Bell },
  shopping: { label: "Shopping & Streaming", Icon: MapPin },
  chat: { label: "Chat & AI", Icon: MessageSquare },
  people: { label: "People & Relationships", Icon: Heart },
  sports: { label: "Sports", Icon: Tv },
  other: { label: "Other", Icon: Wrench },
};

const SKILL_ICON_OVERRIDES: Record<string, LucideIcon> = {
  lookup_tv_show: Tv,
  get_tv_schedule: Tv,
  get_episode_detail: Tv,
};

export function categoryForSkill(skillId: string): string {
  if (ID_TO_CATEGORY[skillId]) return ID_TO_CATEGORY[skillId];
  return "other";
}

export function iconForSkill(skillId: string): LucideIcon {
  return (
    SKILL_ICON_OVERRIDES[skillId] ||
    CATEGORIES[categoryForSkill(skillId)].Icon
  );
}
