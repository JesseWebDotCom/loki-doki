
from app.subsystems.text.web_search import search_web
import json

queries = [
    "Angine de Poitrine band",
    "Angine de Poitrine rock band",
    "Angine de Poitrine Canadian band",
]

for q in queries:
    print(f"Searching for: {q}")
    result = search_web(q)
    print(f"Source: {result.source}")
    print(f"Context Snippet:\n{result.context[:500]}...")
    print("-" * 20)
