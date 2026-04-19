"""Offline maps subsystem.

Owns the region catalog, per-region install state, and the install
pipeline. The only artefact downloaded from the network is the
Geofabrik ``.osm.pbf`` for a region; every other artefact (vector
basemap, routing graph, FTS geocoder) is built locally from that PBF
and lands under ``data/maps/<region_id>/``.

Later chunks layer tile rendering, FTS geocoding, and routing on top —
this package owns only "what's on disk and how it got there".
"""
