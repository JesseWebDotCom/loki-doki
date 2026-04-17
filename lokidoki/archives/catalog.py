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
    category: str                           # "General", "Reference", "Practical", "Education", "Emergency"
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
    StackExchangeSite("dba",               "Database Administrators",  0.4),
    StackExchangeSite("security",          "Information Security",     0.4),
    StackExchangeSite("raspberrypi",       "Raspberry Pi",             0.2),
    StackExchangeSite("arduino",           "Arduino",                  0.2),
    StackExchangeSite("3dprinting",        "3D Printing",              0.1),
    StackExchangeSite("lifehacks",         "Lifehacks",                0.05),
]

# ── Catalog ─────────────────────────────────────────────────────

ZIM_CATALOG: list[ZimSource] = [
    # ── General Knowledge ────────────────────────────────────────
    ZimSource(
        source_id="wikipedia",
        label="Wikipedia",
        description="The free encyclopedia — general reference for almost any topic.",
        favicon_url="https://en.wikipedia.org/favicon.ico",
        category="General",
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
        description="Dictionary, definitions, translations, and etymologies.",
        favicon_url="https://en.wiktionary.org/favicon.ico",
        category="Reference",
        kiwix_dir="wiktionary",
        variants=[
            ZimVariant("all", "Full", 1.8, "all"),
        ],
        default_variant="all",
    ),
    ZimSource(
        source_id="wikibooks",
        label="Wikibooks",
        description="Open-content textbooks and how-to guides.",
        favicon_url="https://en.wikibooks.org/favicon.ico",
        category="Education",
        kiwix_dir="wikibooks",
        variants=[
            ZimVariant("all", "Full", 0.6, "all"),
        ],
        default_variant="all",
    ),
    ZimSource(
        source_id="wikisource",
        label="Wikisource",
        description="Original historical texts, books, and primary documents.",
        favicon_url="https://en.wikisource.org/favicon.ico",
        category="Reference",
        kiwix_dir="wikisource",
        variants=[
            ZimVariant("all", "Full", 2.5, "all"),
        ],
        default_variant="all",
    ),
    ZimSource(
        source_id="wikiquote",
        label="Wikiquote",
        description="Quotes and sayings from notable people and works.",
        favicon_url="https://en.wikiquote.org/favicon.ico",
        category="Reference",
        kiwix_dir="wikiquote",
        variants=[
            ZimVariant("all", "Full", 0.3, "all"),
        ],
        default_variant="all",
    ),
    ZimSource(
        source_id="wikivoyage",
        label="Wikivoyage",
        description="Free worldwide travel guide.",
        favicon_url="https://en.wikivoyage.org/favicon.ico",
        category="Reference",
        kiwix_dir="wikivoyage",
        variants=[
            ZimVariant("all", "Full", 0.8, "all"),
        ],
        default_variant="all",
    ),

    # ── Practical ────────────────────────────────────────────────
    ZimSource(
        source_id="stackexchange",
        label="Stack Exchange",
        description="Community Q&A — tech, DIY, cooking, survival, and more.",
        favicon_url="https://cdn.sstatic.net/Sites/stackoverflow/Img/favicon.ico",
        category="Practical",
        kiwix_dir="stack_exchange",
        variants=[
            ZimVariant("selected", "Selected topics", 0.0, ""),  # size computed from topic selection
        ],
        default_variant="selected",
        is_topic_picker=True,
        available_topics=SE_SITES,
    ),
    ZimSource(
        source_id="ifixit",
        label="iFixit",
        description="Repair guides for electronics, appliances, and vehicles.",
        favicon_url="https://www.ifixit.com/favicon.ico",
        category="Practical",
        kiwix_dir="ifixit",
        variants=[
            ZimVariant("all", "Full", 2.4, "en_all"),
        ],
        default_variant="all",
    ),

    # ── Education ────────────────────────────────────────────────
    ZimSource(
        source_id="gutenberg",
        label="Project Gutenberg",
        description="Classic literature and public domain books.",
        favicon_url="https://www.gutenberg.org/favicon.ico",
        category="Education",
        kiwix_dir="gutenberg",
        variants=[
            ZimVariant("all", "Full library", 60.0, "mul_all"),
        ],
        default_variant="all",
    ),

    # ── Emergency / Survival ─────────────────────────────────────
    ZimSource(
        source_id="mdwiki",
        label="MDWiki (Medical Wikipedia)",
        description="Medical subset of Wikipedia — diseases, symptoms, treatments.",
        favicon_url="https://en.wikipedia.org/favicon.ico",
        category="Emergency",
        kiwix_dir="mdwiki",
        variants=[
            ZimVariant("all", "Full", 1.2, "en_all"),
        ],
        default_variant="all",
    ),
    ZimSource(
        source_id="first_aid",
        label="First Aid & Emergency",
        description="WHO and Red Cross first aid and emergency response guides.",
        favicon_url="https://www.who.int/favicon.ico",
        category="Emergency",
        kiwix_dir="other",
        variants=[
            ZimVariant("all", "Full", 0.2, "who_first_aid"),
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
