
from app.classifier import classify_message

queries = [
    "Who is Mr. T?",
    "How old is Mr. T?",
    "Tell me about Mr. T",
    "Who is Angine de Poitrine?",
]

for q in queries:
    c = classify_message(q)
    print(f"Query: {q}")
    print(f"  Type: {c.request_type}")
    print(f"  Route: {c.route}")
    print("-" * 20)
