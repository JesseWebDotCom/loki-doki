// Mirrors backend/src/lib/books/types.ts's GUTENBERG_CATEGORIES and
// backend/src/lib/books/librivox.ts's LIBRIVOX_CATEGORIES labels, just for
// resolving a category-page title from its URL key without an extra round trip
// (the shelves themselves already come from the backend with the real label
// attached; this is only needed on a direct/refreshed category-page visit).

export const GUTENBERG_CATEGORY_LABELS: Record<string, string> = {
  classic: 'Classics',
  mystery: 'Mystery & Detective',
  'science fiction': 'Science Fiction',
  fantasy: 'Fantasy',
  romance: 'Romance',
  horror: 'Horror & Gothic',
  adventure: 'Adventure',
  drama: 'Drama & Plays',
  history: 'History',
  biography: 'Biography & Memoir',
  philosophy: 'Philosophy',
  poetry: 'Poetry',
  essays: 'Essays',
  humor: 'Humor',
  travel: 'Travel & Exploration',
  'fairy tales': 'Fairy Tales & Folklore',
  children: "Children's Literature",
}

export const MAGAZINE_CATEGORY_LABELS: Record<string, string> = {
  'pc gaming': 'PC & Gaming',
  magazine: 'Current Magazines',
  comic: 'Comics & Anthologies',
  science: 'Science & Technology',
  'art photography': 'Arts & Photography',
  'fashion beauty': 'Fashion & Beauty',
  'business finance': 'Business & Finance',
  'children kids': 'Kids & Family',
  'travel lifestyle': 'Travel & Lifestyle',
  'sports outdoor': 'Sports & Outdoors',
  'music entertainment': 'Music & Entertainment',
}

export const LIBRIVOX_CATEGORY_LABELS: Record<string, string> = {
  fiction: 'Classic Fiction',
  mystery: 'Mystery & Detective',
  'science fiction': 'Science Fiction',
  fantasy: 'Fantasy',
  romance: 'Romance',
  horror: 'Horror & Gothic',
  adventure: 'Adventure',
  drama: 'Drama & Plays',
  history: 'History',
  biography: 'Biography & Memoir',
  philosophy: 'Philosophy',
  poetry: 'Poetry',
  essays: 'Essays',
  humor: 'Humor',
  travel: 'Travel & Exploration',
  children: "Children's Literature",
}
