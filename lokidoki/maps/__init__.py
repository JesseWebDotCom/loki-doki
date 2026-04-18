"""Offline maps subsystem.

Owns the region catalog, per-region install state, and the download
pipeline that lands ``.pmtiles`` / satellite tarballs / Geofabrik
``.osm.pbf`` / prebuilt Valhalla tiles under ``data/maps/<region_id>/``.

Chunks 3+ of the offline-maps plan layer tile rendering, FTS geocoding,
and routing on top — this package owns only "what's on disk and how it
got there".
"""
