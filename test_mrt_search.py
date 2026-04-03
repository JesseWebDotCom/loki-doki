
from app.subsystems.text.web_search import search_web
import json

queries = [
    "How old is Mr. T?",
    "Mr. T birth date",
]

for q in queries:
    print(f"Searching for: {q}")
    result = search_web(q)
    print(f"Source: {result.source}")
    print(f"Context Snippet:\n{result.context[:1000]}...")
    print("-" * 20)
