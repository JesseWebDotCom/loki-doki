
from app.classifier import classify_message

test_queries = [
    "Do you know who Angine de Poitrine is?",
    "still wrong, can't you search wikipedia for this",
    "search the web for Angine de Poitrine",
    "who is the lead singer of Angine de Poitrine",
    "what is the latest news about Angine de Poitrine",
    "Tano", # person's name or just noise in user's prompt? The user's prompt had "Tano" at the end of each block, likely their username/persona.
]

for query in test_queries:
    classification = classify_message(query)
    print(f"Query: {query}")
    print(f"  Type: {classification.request_type}")
    print(f"  Route: {classification.route}")
    print(f"  Reason: {classification.reason}")
    print("-" * 20)
