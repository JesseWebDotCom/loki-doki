"""Static catalog of available ZIM archive sources.

Each entry describes a content source (Wikipedia, Wiktionary, etc.),
its available variants (full, nopic, mini), and where to download it.
The catalog is the single source of truth for what archives LokiDoki
can offer — the admin panel reads it, the bootstrap favicon step
iterates it, and the download resolver resolves URLs from it.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class ZimVariant:
    """One size/content variant of a ZIM source."""

    key: str                # e.g. "full", "nopic", "mini"
    label: str              # e.g. "Full (with images)"
    approx_size_gb: float   # approximate download size
    url_slug: str           # Kiwix directory filename fragment, e.g. "all_maxi", "all_nopic"


@dataclass(frozen=True)
class StackExchangeSite:
    """One Stack Exchange site available for selective download."""

    site_id: str    # e.g. "stackoverflow", "unix", "diy"
    label: str      # e.g. "Stack Overflow", "Unix & Linux"
    approx_size_gb: float


@dataclass(frozen=True)
class ZimSource:
    """A content source available as a ZIM archive."""

    source_id: str
    label: str
    description: str
    favicon_url: str
    # PrepperDisk-style category labels: Knowledge, Maintenance, Medical,
    # Survival, Education, Reference, Inspiration. Rendered as the small
    # ALL CAPS header on each admin panel card.
    category: str
    variants: list[ZimVariant]
    default_variant: str                    # key of the default variant
    languages: list[str] = field(default_factory=lambda: ["en"])
    default_language: str = "en"
    is_topic_picker: bool = False           # True for Stack Exchange
    available_topics: list[StackExchangeSite] = field(default_factory=list)
    kiwix_dir: str = ""                     # subdirectory on download.kiwix.org/zim/


# ── Stack Exchange sites ────────────────────────────────────────

SE_SITES: list[StackExchangeSite] = [
    StackExchangeSite("stackoverflow",      "Stack Overflow",         30.0),
    StackExchangeSite("serverfault",        "Server Fault",            1.5),
    StackExchangeSite("superuser",          "Super User",              2.0),
    StackExchangeSite("askubuntu",          "Ask Ubuntu",              1.8),
    StackExchangeSite("unix",              "Unix & Linux",             0.8),
    StackExchangeSite("diy",               "Home Improvement (DIY)",   0.5),
    StackExchangeSite("cooking",           "Seasoned Advice (Cooking)",0.3),
    StackExchangeSite("electronics",       "Electrical Engineering",   0.6),
    StackExchangeSite("mechanics",         "Motor Vehicle Maintenance",0.3),
    StackExchangeSite("outdoors",          "The Great Outdoors",       0.1),
    StackExchangeSite("gardening",         "Gardening & Landscaping",  0.1),
    StackExchangeSite("sustainability",    "Sustainable Living",       0.1),
    StackExchangeSite("dba",               "Database Administrators",  0.4),
    StackExchangeSite("security",          "Information Security",     0.4),
    StackExchangeSite("raspberrypi",       "Raspberry Pi",             0.2),
    StackExchangeSite("arduino",           "Arduino",                  0.2),
    StackExchangeSite("3dprinting",        "3D Printing",              0.1),
    StackExchangeSite("lifehacks",         "Lifehacks",                0.05),
]

# ── Catalog ─────────────────────────────────────────────────────

ZIM_CATALOG: list[ZimSource] = [
    # ── KNOWLEDGE — encyclopedic, general reference ──────────────
    ZimSource(
        source_id="wikipedia",
        label="English Wikipedia",
        description="Over 6 million articles — the world's largest encyclopedia. General reference for almost any topic.",
        favicon_url="https://en.wikipedia.org/favicon.ico",
        category="Knowledge",
        kiwix_dir="wikipedia",
        variants=[
            ZimVariant("maxi",  "Full (with images)",       97.0,  "all_maxi"),
            ZimVariant("nopic", "No images (all articles)", 47.0,  "all_nopic"),
            ZimVariant("mini",  "Mini (~top 10%, no images)", 8.0, "all_mini"),
        ],
        default_variant="mini",
    ),
    ZimSource(
        source_id="wiktionary",
        label="Wiktionary",
        description="Dictionary, definitions, translations, and etymologies for dozens of languages.",
        favicon_url="https://en.wiktionary.org/favicon.ico",
        category="Knowledge",
        kiwix_dir="wiktionary",
        variants=[
            ZimVariant("all", "Full", 1.8, "all"),
        ],
        default_variant="all",
    ),
    ZimSource(
        source_id="wikiquote",
        label="Wikiquote",
        description="Memorable quotes and sayings from notable people, books, and films.",
        favicon_url="https://en.wikiquote.org/favicon.ico",
        category="Knowledge",
        kiwix_dir="wikiquote",
        variants=[
            ZimVariant("all", "Full", 0.3, "all"),
        ],
        default_variant="all",
    ),
    ZimSource(
        source_id="wikisource",
        label="Wikisource",
        description="Original historical texts, public-domain books, and primary documents.",
        favicon_url="https://en.wikisource.org/favicon.ico",
        category="Knowledge",
        kiwix_dir="wikisource",
        variants=[
            ZimVariant("all", "Full", 2.5, "all"),
        ],
        default_variant="all",
    ),
    ZimSource(
        source_id="vikidia",
        label="Vikidia",
        description="Kid-friendly encyclopedia for ages 8-13 — simpler language, curated topics.",
        favicon_url="https://en.vikidia.org/favicon.ico",
        category="Knowledge",
        kiwix_dir="vikidia",
        variants=[
            ZimVariant("all", "Full", 0.08, "en_all_maxi"),
        ],
        default_variant="all",
    ),

    # ── MAINTENANCE — repair, DIY, community Q&A ─────────────────
    ZimSource(
        source_id="ifixit",
        label="iFixit Repair Guides",
        description="Thousands of repair guides for automotive, appliances, electronics, and more.",
        favicon_url="https://www.ifixit.com/favicon.ico",
        category="Maintenance",
        kiwix_dir="ifixit",
        variants=[
            ZimVariant("all", "Full", 2.4, "en_all"),
        ],
        default_variant="all",
    ),
    ZimSource(
        source_id="stackexchange",
        label="Q&A's from Stack Exchange",
        description="Thousands of questions and answers on automotive repair, carpentry and woodworking, sustainable living, and more.",
        favicon_url="https://cdn.sstatic.net/Sites/stackoverflow/Img/favicon.ico",
        category="Maintenance",
        kiwix_dir="stack_exchange",
        variants=[
            ZimVariant("selected", "Selected topics", 0.0, ""),
        ],
        default_variant="selected",
        is_topic_picker=True,
        available_topics=SE_SITES,
    ),

    # ── SURVIVAL — sustainability, appropriate tech, prep ────────
    ZimSource(
        source_id="appropedia",
        label="Appropedia",
        description="Sustainability, DIY, and appropriate-technology how-to guides — off-grid, water, food, energy.",
        favicon_url="https://www.appropedia.org/favicon.ico",
        category="Survival",
        kiwix_dir="other",
        variants=[
            ZimVariant("all", "Full", 1.8, "appropedia_en_all_maxi"),
        ],
        default_variant="all",
    ),

    # ── MEDICAL — health and emergency medicine ──────────────────
    ZimSource(
        source_id="mdwiki",
        label="MDWiki Medical Encyclopedia",
        description="50,000+ healthcare articles from Wikipedia and the Wiki Project Med Foundation.",
        favicon_url="https://en.wikipedia.org/favicon.ico",
        category="Medical",
        kiwix_dir="other",
        variants=[
            ZimVariant("maxi", "Full (with images)", 2.0, "mdwiki_en_all_maxi"),
        ],
        default_variant="maxi",
    ),
    ZimSource(
        source_id="wikem",
        label="WikEM (Emergency Medicine)",
        description="Clinical emergency medicine reference — triage, protocols, procedures for first responders.",
        favicon_url="https://wikem.org/favicon.ico",
        category="Medical",
        kiwix_dir="other",
        variants=[
            ZimVariant("maxi", "Full (with images)", 0.4, "wikem_en_all_maxi"),
            ZimVariant("nopic", "No images", 0.3, "wikem_en_all_nopic"),
        ],
        default_variant="nopic",
    ),

    # ── EDUCATION — textbooks, courses, classics ─────────────────
    ZimSource(
        source_id="khanacademy",
        label="Khan Academy Lite",
        description="Thousands of learning videos and quizzes — math, science, history, computing.",
        favicon_url="https://www.khanacademy.org/favicon.ico",
        category="Education",
        kiwix_dir="other",
        variants=[
            ZimVariant("all", "Full (all subjects)", 45.0, "khanacademy_en_all"),
        ],
        default_variant="all",
    ),
    ZimSource(
        source_id="freecodecamp",
        label="freeCodeCamp",
        description="Interactive coding curriculum — JavaScript, Python, web development, algorithms.",
        favicon_url="https://www.freecodecamp.org/favicon.ico",
        category="Education",
        kiwix_dir="freecodecamp",
        variants=[
            ZimVariant("all", "Full curriculum", 0.01, "en_all"),
            ZimVariant("javascript", "JavaScript only", 0.01, "en_javascript-algorithms-and-data-structures"),
        ],
        default_variant="all",
    ),
    ZimSource(
        source_id="gutenberg",
        label="Project Gutenberg Library",
        description="Over 60,000 classic books and texts in the public domain.",
        favicon_url="https://www.gutenberg.org/favicon.ico",
        category="Education",
        kiwix_dir="gutenberg",
        variants=[
            ZimVariant("all", "Full library", 60.0, "mul_all"),
        ],
        default_variant="all",
    ),
    ZimSource(
        source_id="wikibooks",
        label="Wikibooks",
        description="Open-content textbooks, how-to guides, and instructional manuals.",
        favicon_url="https://en.wikibooks.org/favicon.ico",
        category="Education",
        kiwix_dir="wikibooks",
        variants=[
            ZimVariant("all", "Full", 0.6, "all"),
        ],
        default_variant="all",
    ),

    # ── INSPIRATION — TED talks ──────────────────────────────────
    ZimSource(
        source_id="ted_agriculture",
        label="TED Talks — Agriculture",
        description="TED talks on farming, food systems, and sustainable agriculture.",
        favicon_url="https://www.ted.com/favicon.ico",
        category="Inspiration",
        kiwix_dir="ted",
        variants=[
            ZimVariant("all", "Full", 1.5, "ted_mul_agriculture"),
        ],
        default_variant="all",
    ),
    ZimSource(
        source_id="ted_ai",
        label="TED Talks — AI & Technology",
        description="TED talks on artificial intelligence, machine learning, and emerging tech.",
        favicon_url="https://www.ted.com/favicon.ico",
        category="Inspiration",
        kiwix_dir="ted",
        # Trailing underscore guards against substring collision with
        # ``ted_mul_aids_*`` (AIDS has same 3-letter prefix as AI).
        variants=[
            ZimVariant("all", "Full", 1.5, "ted_mul_ai_"),
        ],
        default_variant="all",
    ),

    # ── NAVIGATION — travel + geography ──────────────────────────
    ZimSource(
        source_id="wikivoyage",
        label="Wikivoyage",
        description="Free worldwide travel guide — destinations, itineraries, practical info.",
        favicon_url="https://en.wikivoyage.org/favicon.ico",
        category="Navigation",
        kiwix_dir="wikivoyage",
        variants=[
            ZimVariant("all", "Full", 0.8, "all"),
        ],
        default_variant="all",
    ),
    ZimSource(
        source_id="openstreetmap_wiki",
        label="OpenStreetMap Wiki",
        description="Mapping documentation, tagging conventions, and geographic data reference.",
        favicon_url="https://www.openstreetmap.org/favicon.ico",
        category="Navigation",
        kiwix_dir="other",
        variants=[
            ZimVariant("all", "Full", 1.0, "openstreetmap-wiki_en_all_maxi"),
        ],
        default_variant="all",
    ),

    # ── REFERENCE — country facts, technical docs ────────────────
    ZimSource(
        source_id="factbook",
        label="CIA World Factbook",
        description="Country profiles — population, economy, government, and geography statistics.",
        favicon_url="https://www.cia.gov/the-world-factbook/favicon.ico",
        category="Reference",
        kiwix_dir="other",
        variants=[
            ZimVariant("all", "Full", 0.1, "theworldfactbook_en_all"),
        ],
        default_variant="all",
    ),
    ZimSource(
        source_id="archlinux",
        label="Arch Linux Wiki",
        description="Comprehensive Linux admin reference — systemd, networking, hardware, troubleshooting.",
        favicon_url="https://archlinux.org/favicon.ico",
        category="Reference",
        kiwix_dir="other",
        variants=[
            ZimVariant("all", "Full", 0.03, "archlinux_en_all_maxi"),
        ],
        default_variant="all",
    ),
    ZimSource(
        source_id="python_docs",
        label="Python Documentation",
        description="Official Python language reference and standard library documentation.",
        favicon_url="https://www.python.org/favicon.ico",
        category="Reference",
        kiwix_dir="devdocs",
        variants=[
            ZimVariant("all", "Full", 2.5, "en_python"),
        ],
        default_variant="all",
    ),
]


def get_source(source_id: str) -> ZimSource | None:
    """Look up a catalog entry by source_id."""
    return next((s for s in ZIM_CATALOG if s.source_id == source_id), None)


def get_variant(source: ZimSource, variant_key: str) -> ZimVariant | None:
    """Look up a variant within a source."""
    return next((v for v in source.variants if v.key == variant_key), None)
