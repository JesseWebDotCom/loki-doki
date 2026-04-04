
from app.classifier import _is_web_query, _normalized_words, _looks_like_live_lookup, _has_lookup_prefix, classify_message

msg = "did chatgpt recently change how it throttles codex?"
words = _normalized_words(msg)
print(f"cleaned: {msg}")
print(f"words: {words}")
print(f"has_lookup_prefix: {_has_lookup_prefix(msg)}")
print(f"looks_like_live_lookup: {_looks_like_live_lookup(msg, words)}")
print(f"is_web_query: {_is_web_query(msg, words)}")
print(f"classification: {classify_message(msg)}")
