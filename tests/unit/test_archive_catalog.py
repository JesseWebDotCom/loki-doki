"""Validate the ZIM archive catalog structure."""
from lokidoki.archives.catalog import ZIM_CATALOG, get_source, get_variant


def test_no_duplicate_source_ids():
    ids = [s.source_id for s in ZIM_CATALOG]
    assert len(ids) == len(set(ids)), f"Duplicate source IDs: {ids}"


def test_all_sources_have_variants():
    for source in ZIM_CATALOG:
        assert len(source.variants) >= 1, f"{source.source_id} has no variants"


def test_default_variant_exists():
    for source in ZIM_CATALOG:
        keys = [v.key for v in source.variants]
        assert source.default_variant in keys, (
            f"{source.source_id} default_variant={source.default_variant!r} "
            f"not in {keys}"
        )


def test_all_favicon_urls_are_https():
    for source in ZIM_CATALOG:
        assert source.favicon_url.startswith("https://"), (
            f"{source.source_id} favicon_url is not HTTPS: {source.favicon_url}"
        )


def test_topic_picker_has_topics():
    for source in ZIM_CATALOG:
        if source.is_topic_picker:
            assert len(source.available_topics) > 0, (
                f"{source.source_id} is_topic_picker=True but has no topics"
            )


def test_non_topic_picker_has_no_topics():
    for source in ZIM_CATALOG:
        if not source.is_topic_picker:
            assert len(source.available_topics) == 0, (
                f"{source.source_id} is_topic_picker=False but has topics"
            )


def test_get_source_found():
    assert get_source("wikipedia") is not None
    assert get_source("wikipedia").label == "Wikipedia"


def test_get_source_missing():
    assert get_source("nonexistent") is None


def test_get_variant_found():
    wp = get_source("wikipedia")
    assert wp is not None
    v = get_variant(wp, "mini")
    assert v is not None
    assert v.approx_size_gb > 0


def test_get_variant_missing():
    wp = get_source("wikipedia")
    assert wp is not None
    assert get_variant(wp, "nonexistent") is None


def test_all_sources_have_category():
    for source in ZIM_CATALOG:
        assert source.category, f"{source.source_id} has no category"


def test_all_sources_have_kiwix_dir():
    for source in ZIM_CATALOG:
        assert source.kiwix_dir, f"{source.source_id} has no kiwix_dir"
