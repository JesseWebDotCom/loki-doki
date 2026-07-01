// Seed data for built-in pronunciation packs. Reconciled at boot — inserts missing
// rows, never overwrites admin's enabled toggle or custom edits.

export interface PackSeed {
  slug: string
  name: string
  appKey: string | null
  description: string
  items: { term: string; replacement: string }[]
}

export const BUILTIN_PRONUNCIATION_PACKS: PackSeed[] = [
  // ── Chat & Messaging ─────────────────────────────────────────────────────────
  {
    slug: 'chat',
    name: 'Chat & Messaging',
    appKey: 'chat',
    description: 'Common abbreviations and acronyms used in chat and messages.',
    items: [
      { term: 'lol',    replacement: 'el oh el' },
      { term: 'lmao',   replacement: 'el em ay oh' },
      { term: 'omg',    replacement: 'oh my god' },
      { term: 'omfg',   replacement: 'oh my effing god' },
      { term: 'wtf',    replacement: 'W T F' },
      { term: 'WTF',    replacement: 'W T F' },
      { term: 'brb',    replacement: 'be right back' },
      { term: 'afk',    replacement: 'away from keyboard' },
      { term: 'irl',    replacement: 'in real life' },
      { term: 'tbh',    replacement: 'to be honest' },
      { term: 'imo',    replacement: 'in my opinion' },
      { term: 'imho',   replacement: 'in my humble opinion' },
      { term: 'ngl',    replacement: "not gonna lie" },
      { term: 'idk',    replacement: "I don't know" },
      { term: 'ikr',    replacement: 'I know, right' },
      { term: 'smh',    replacement: 'shaking my head' },
      { term: 'btw',    replacement: 'by the way' },
      { term: 'fyi',    replacement: 'for your information' },
      { term: 'aka',    replacement: 'also known as' },
      { term: 'asap',   replacement: 'as soon as possible' },
      { term: 'ASAP',   replacement: 'as soon as possible' },
      { term: 'eta',    replacement: 'E T A' },
      { term: 'ETA',    replacement: 'E T A' },
      { term: 'npc',    replacement: 'N P C' },
      { term: 'NPC',    replacement: 'N P C' },
      { term: 'gg',     replacement: 'good game' },
      { term: 'GG',     replacement: 'good game' },
      { term: 'wfh',    replacement: 'working from home' },
      { term: 'WFH',    replacement: 'working from home' },
      { term: 'tmi',    replacement: 'too much information' },
      { term: 'TMI',    replacement: 'too much information' },
      { term: 'diy',    replacement: 'do it yourself' },
      { term: 'DIY',    replacement: 'do it yourself' },
      { term: 'nsfw',   replacement: 'not safe for work' },
      { term: 'NSFW',   replacement: 'not safe for work' },
      { term: 'etc.',   replacement: 'et cetera' },
      { term: 'e.g.',   replacement: 'for example' },
      { term: 'i.e.',   replacement: 'that is' },
      { term: 'vs.',    replacement: 'versus' },
      { term: 'IOU',    replacement: 'I owe you' },
      { term: 'TL;DR',  replacement: "too long, didn't read" },
      { term: 'tldr',   replacement: "too long, didn't read" },
      { term: 'FAQ',    replacement: 'F A Q' },
      { term: 'URL',    replacement: 'U R L' },
      { term: 'UI',     replacement: 'U I' },
      { term: 'UX',     replacement: 'U X' },
    ],
  },

  // ── Navigation & Maps ────────────────────────────────────────────────────────
  {
    slug: 'maps',
    name: 'Navigation & Maps',
    appKey: 'maps',
    description: 'Street address abbreviations for navigation directions.',
    items: [
      { term: 'St.',    replacement: 'Street' },
      { term: 'Ave.',   replacement: 'Avenue' },
      { term: 'Blvd.',  replacement: 'Boulevard' },
      { term: 'Ln.',    replacement: 'Lane' },
      { term: 'Rd.',    replacement: 'Road' },
      { term: 'Dr.',    replacement: 'Drive' },
      { term: 'Hwy.',   replacement: 'Highway' },
      { term: 'Fwy.',   replacement: 'Freeway' },
      { term: 'Pkwy.',  replacement: 'Parkway' },
      { term: 'Ct.',    replacement: 'Court' },
      { term: 'Pl.',    replacement: 'Place' },
      { term: 'Sq.',    replacement: 'Square' },
      { term: 'Apt.',   replacement: 'Apartment' },
      { term: 'Ste.',   replacement: 'Suite' },
      { term: 'Bldg.',  replacement: 'Building' },
    ],
  },

  // ── Music & Artists ──────────────────────────────────────────────────────────
  {
    slug: 'music',
    name: 'Music & Artists',
    appKey: 'music',
    description: 'Band names, artist abbreviations, and music terminology.',
    items: [
      // Artist/band names TTS gets wrong
      { term: 'INXS',         replacement: 'in excess' },
      { term: 'MGMT',         replacement: 'M G M T' },
      { term: 'SZA',          replacement: 'sizza' },
      { term: 'RZA',          replacement: 'rizza' },
      { term: 'GZA',          replacement: 'gizza' },
      { term: 'MF DOOM',      replacement: 'M F Doom' },
      { term: 'XTC',          replacement: 'X T C' },
      { term: 'FKA',          replacement: 'F K A' },
      { term: 'YG',           replacement: 'why gee' },
      { term: 'BTS',          replacement: 'B T S' },
      { term: 'N.W.A.',       replacement: 'N W A' },
      { term: 'PVRIS',        replacement: 'paris' },
      { term: 'CHVRCHES',     replacement: 'churches' },
      { term: 'BROCKHAMPTON', replacement: 'brock hampton' },
      { term: 'slowthai',     replacement: 'slow thai' },
      { term: 'dvsn',         replacement: 'division' },
      { term: 'boygenius',    replacement: 'boy genius' },
      { term: 'XXXTentacion', replacement: 'ex ex ex ten-ta-see-on' },
      { term: 'The Weeknd',   replacement: 'the weekend' },
      { term: 'Weeknd',       replacement: 'weekend' },
      { term: '2Pac',         replacement: 'Tupac' },
      { term: 'Björk',        replacement: 'byork' },
      { term: 'Bon Iver',     replacement: 'bohn ee-vair' },
      { term: 'Sufjan',       replacement: 'soof-yan' },
      { term: 'Troye',        replacement: 'troy' },
      { term: 'Eilish',       replacement: 'eye-lish' },
      { term: 'Khalid',       replacement: 'khah-leed' },
      { term: 'Rosalía',      replacement: 'rosa-lee-a' },
      { term: 'Sigur Rós',    replacement: 'see-gur rose' },
      { term: 'Mötley Crüe',  replacement: 'mot-lee crew' },
      { term: 'Motörhead',    replacement: 'motor-hed' },
      { term: 'Sivan',        replacement: 'sy-van' },
      // Music terminology
      { term: 'AC/DC',  replacement: 'A C D C' },
      { term: 'ACDC',   replacement: 'A C D C' },
      { term: 'R&B',    replacement: 'R and B' },
      { term: 'EDM',    replacement: 'E D M' },
      { term: 'feat.',  replacement: 'featuring' },
      { term: 'prod.',  replacement: 'produced by' },
      { term: 'lo-fi',  replacement: 'low fi' },
      { term: 'Lo-Fi',  replacement: 'low fi' },
      { term: 'hi-fi',  replacement: 'high fi' },
      { term: 'Hi-Fi',  replacement: 'high fi' },
      { term: 'w/',     replacement: 'with' },
    ],
  },

  // ── Units & Measurements ─────────────────────────────────────────────────────
  {
    slug: 'units',
    name: 'Units & Measurements',
    appKey: null,
    description: 'Physical units, data sizes, and frequencies read out in full.',
    items: [
      // Speed
      { term: 'mph',    replacement: 'miles per hour' },
      { term: 'kph',    replacement: 'kilometers per hour' },
      { term: 'km/h',   replacement: 'kilometers per hour' },
      { term: 'mpg',    replacement: 'miles per gallon' },
      // Weight / volume
      { term: 'lbs.',   replacement: 'pounds' },
      { term: 'lbs',    replacement: 'pounds' },
      { term: 'oz.',    replacement: 'ounces' },
      { term: 'oz',     replacement: 'ounces' },
      { term: 'ml',     replacement: 'milliliters' },
      { term: 'mL',     replacement: 'milliliters' },
      { term: 'mg',     replacement: 'milligrams' },
      // Temperature
      { term: '°F',     replacement: 'degrees Fahrenheit' },
      { term: '°C',     replacement: 'degrees Celsius' },
      // Storage
      { term: 'KB',     replacement: 'kilobytes' },
      { term: 'MB',     replacement: 'megabytes' },
      { term: 'GB',     replacement: 'gigabytes' },
      { term: 'TB',     replacement: 'terabytes' },
      { term: 'PB',     replacement: 'petabytes' },
      // Frequency
      { term: 'Hz',     replacement: 'hertz' },
      { term: 'kHz',    replacement: 'kilohertz' },
      { term: 'MHz',    replacement: 'megahertz' },
      { term: 'GHz',    replacement: 'gigahertz' },
      // Power
      { term: 'kW',     replacement: 'kilowatts' },
      { term: 'kWh',    replacement: 'kilowatt-hours' },
      { term: 'MW',     replacement: 'megawatts' },
      // Other
      { term: 'rpm',    replacement: 'revolutions per minute' },
      { term: 'RPM',    replacement: 'revolutions per minute' },
      { term: 'psi',    replacement: 'P S I' },
      { term: 'approx.',replacement: 'approximately' },
      { term: 'approx', replacement: 'approximately' },
    ],
  },

  // ── Dates & Times ────────────────────────────────────────────────────────────
  {
    slug: 'dates',
    name: 'Dates & Times',
    appKey: null,
    description: 'Abbreviated days, months, and time suffixes spelled out in full.',
    items: [
      // Days
      { term: 'Mon.',   replacement: 'Monday' },
      { term: 'Tue.',   replacement: 'Tuesday' },
      { term: 'Wed.',   replacement: 'Wednesday' },
      { term: 'Thu.',   replacement: 'Thursday' },
      { term: 'Fri.',   replacement: 'Friday' },
      { term: 'Sat.',   replacement: 'Saturday' },
      { term: 'Sun.',   replacement: 'Sunday' },
      // Months
      { term: 'Jan.',   replacement: 'January' },
      { term: 'Feb.',   replacement: 'February' },
      { term: 'Mar.',   replacement: 'March' },
      { term: 'Apr.',   replacement: 'April' },
      { term: 'Jun.',   replacement: 'June' },
      { term: 'Jul.',   replacement: 'July' },
      { term: 'Aug.',   replacement: 'August' },
      { term: 'Sep.',   replacement: 'September' },
      { term: 'Sept.',  replacement: 'September' },
      { term: 'Oct.',   replacement: 'October' },
      { term: 'Nov.',   replacement: 'November' },
      { term: 'Dec.',   replacement: 'December' },
      // Time
      { term: 'a.m.',   replacement: 'A M' },
      { term: 'p.m.',   replacement: 'P M' },
    ],
  },

  // ── Tech & Software ──────────────────────────────────────────────────────────
  {
    slug: 'tech',
    name: 'Tech & Software',
    appKey: null,
    description: 'Tech acronyms, protocols, and developer terms.',
    items: [
      // Hardware
      { term: 'CPU',    replacement: 'C P U' },
      { term: 'GPU',    replacement: 'G P U' },
      { term: 'SSD',    replacement: 'S S D' },
      { term: 'NVMe',   replacement: 'N V me' },
      { term: 'USB',    replacement: 'U S B' },
      { term: 'HDMI',   replacement: 'H D M I' },
      { term: 'OLED',   replacement: 'oh led' },
      { term: 'QLED',   replacement: 'Q led' },
      { term: 'HDR',    replacement: 'H D R' },
      // Networking
      { term: 'WiFi',   replacement: 'why fi' },
      { term: 'Wi-Fi',  replacement: 'why fi' },
      { term: 'VPN',    replacement: 'V P N' },
      { term: 'HTTP',   replacement: 'H T T P' },
      { term: 'HTTPS',  replacement: 'H T T P S' },
      { term: 'DNS',    replacement: 'D N S' },
      { term: 'SSH',    replacement: 'S S H' },
      { term: 'IP',     replacement: 'I P' },
      // Platforms
      { term: 'iOS',    replacement: 'I O S' },
      { term: 'macOS',  replacement: 'mac O S' },
      { term: 'iPadOS', replacement: 'I pad O S' },
      { term: 'tvOS',   replacement: 'T V O S' },
      { term: 'watchOS',replacement: 'watch O S' },
      // Dev
      { term: 'API',    replacement: 'A P I' },
      { term: 'SQL',    replacement: 'sequel' },
      { term: 'CLI',    replacement: 'C L I' },
      { term: 'IDE',    replacement: 'I D E' },
      { term: 'CI/CD',  replacement: 'C I C D' },
      { term: 'npm',    replacement: 'N P M' },
      { term: 'LLM',    replacement: 'L L M' },
      { term: 'ML',     replacement: 'M L' },
      { term: 'NLP',    replacement: 'N L P' },
      { term: 'OCR',    replacement: 'O C R' },
      { term: 'SaaS',   replacement: 'sass' },
    ],
  },

  // ── Companies & Brands ───────────────────────────────────────────────────────
  {
    slug: 'brands',
    name: 'Companies & Brands',
    appKey: null,
    description: 'Brand names that TTS consistently mispronounces.',
    items: [
      // Automotive
      { term: 'Hyundai',      replacement: 'hun-day' },
      { term: 'Porsche',      replacement: 'por-sha' },
      { term: 'Volkswagen',   replacement: 'folks-vah-gun' },
      { term: 'Peugeot',      replacement: 'puh-zhoh' },
      { term: 'Renault',      replacement: 'ruh-noh' },
      { term: 'Citroën',      replacement: 'sit-roh-en' },
      { term: 'Audi',         replacement: 'ow-dee' },
      { term: 'Lamborghini',  replacement: 'lam-bor-gee-nee' },
      { term: 'Bugatti',      replacement: 'boo-gah-tee' },
      { term: 'Maserati',     replacement: 'maz-uh-rah-tee' },
      { term: 'Koenigsegg',   replacement: 'keh-nig-seg' },
      // Tech companies
      { term: 'Xiaomi',       replacement: 'show-mee' },
      { term: 'Huawei',       replacement: 'hwah-way' },
      { term: 'NVIDIA',       replacement: 'en-vid-ee-uh' },
      { term: 'Asus',         replacement: 'ay-soos' },
      { term: 'Lenovo',       replacement: 'leh-noh-voh' },
      { term: 'Logitech',     replacement: 'loh-jih-tech' },
      { term: 'GIF',          replacement: 'jif' },
      // Fashion / luxury
      { term: 'Versace',      replacement: 'ver-sah-chay' },
      { term: 'Givenchy',     replacement: 'zhee-von-shee' },
      { term: 'Moschino',     replacement: 'mos-kee-no' },
      { term: 'Hermès',       replacement: 'air-mez' },
      { term: 'Louis Vuitton',replacement: 'loo-ee vwee-tohn' },
      { term: 'Vuitton',      replacement: 'vwee-tohn' },
      { term: 'Balmain',      replacement: 'bal-man' },
      { term: 'Yves',         replacement: 'eev' },
      { term: 'Dior',         replacement: 'dee-or' },
      { term: 'Loewe',        replacement: 'loh-EH-veh' },
      // Food & retail
      { term: 'Nestlé',       replacement: 'nes-lay' },
      { term: 'Häagen-Dazs',  replacement: 'hah-gen dahs' },
      { term: 'Lidl',         replacement: 'lee-dl' },
      { term: 'IKEA',         replacement: 'eye-kee-a' },
      { term: 'Adidas',       replacement: 'ah-dee-das' },
      { term: 'H&M',          replacement: 'H and M' },
      { term: 'LVMH',         replacement: 'el vee em aitch' },
      { term: 'L\'Oréal',     replacement: 'loh-ray-al' },
      { term: 'Michelin',     replacement: 'mish-uh-lin' },
    ],
  },

  // ── Pop Culture & Entertainment ──────────────────────────────────────────────
  // Only names where English phonics genuinely lead TTS astray — not things
  // that read out fine (Aragorn, Gollum, Geralt, Pikachu, etc.).
  {
    slug: 'popculture',
    name: 'Pop Culture & Entertainment',
    appKey: null,
    description: 'Names and terms where standard English phonics lead TTS astray.',
    items: [
      // Harry Potter — silent letters / non-obvious stress
      { term: 'Hermione',     replacement: 'her-my-oh-nee' },
      { term: 'Voldemort',    replacement: 'vol-duh-mor' },  // T is silent
      // Game of Thrones — invented or foreign-rooted words
      { term: 'Daenerys',     replacement: 'duh-nair-ees' },
      { term: 'Cersei',       replacement: 'ser-say' },
      { term: 'Khaleesi',     replacement: 'khuh-lee-see' },
      { term: 'Targaryen',    replacement: 'tar-gair-ee-en' },
      { term: 'Dothraki',     replacement: 'doh-thrak-ee' },
      { term: 'Jaqen',        replacement: 'jay-ken' },
      // Marvel
      { term: 'Mjolnir',      replacement: 'myol-neer' },
      { term: 'Thanos',       replacement: 'thay-nos' },
      { term: 'Vibranium',    replacement: 'vy-bray-nee-um' },
      // LOTR — non-obvious vowels
      { term: 'Smaug',        replacement: 'smawg' },
      { term: 'Tolkien',      replacement: 'tol-keen' },
      // Pokémon — accented name + genuinely wrong pronunciations
      { term: 'Pokémon',      replacement: 'poh-kay-mon' },
      { term: 'Pokemon',      replacement: 'poh-kay-mon' },
      { term: 'Gyarados',     replacement: 'gy-ah-ra-dos' },
      { term: 'Arceus',       replacement: 'ar-see-us' },
      // Gaming
      { term: 'Hyrule',       replacement: 'hy-rool' },
      { term: 'Sekiro',       replacement: 'seh-kee-roh' },
      { term: 'Cthulhu',      replacement: 'kuh-thoo-loo' },
      // Anime — Japanese stress/vowels
      { term: 'Sasuke',       replacement: 'sah-soo-keh' },
      { term: 'Itachi',       replacement: 'ee-tah-chee' },
      { term: 'Kakashi',      replacement: 'kah-kah-shee' },
      { term: 'Vegeta',       replacement: 'veh-jee-ta' },
      { term: 'Jujutsu',      replacement: 'joo-joot-soo' },
      { term: 'Sukuna',       replacement: 'soo-koo-nah' },
    ],
  },
]
