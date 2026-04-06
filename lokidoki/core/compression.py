import re

# Standard English stop-words that carry low semantic weight (partial list)
STOP_WORDS = {
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "in", "on", "at", "by", "for", "with", "about", "against", "between",
    "into", "through", "during", "before", "after", "above", "below", "to",
    "from", "up", "down", "off", "over", "under", "again", "further", "then",
    "once", "here", "there", "when", "where", "why", "how", "all", "any",
    "both", "each", "few", "more", "most", "other", "some", "such", "nor",
    "own", "same", "so", "than", "too", "very", "can", "will", "just", "should", "now"
}

# Smart-Caveman Signals (MUST PRESERVE)
PRESERVED_WORDS = {
    # Negatives
    "not", "no", "never", "cannot", "none",
    # Logic
    "but", "if", "however", "only", "because",
    # Time/Context
    "today", "tomorrow", "yesterday"
}

def compress_text(text: str) -> str:
    """
    Compresses text using 'Caveman' rules: strips low-signal stop-words,
    while preserving critical status/logical/quantity modifiers.
    """
    if not text:
        return ""

    # 1. Noise Reduction: Strip HTML tags
    text = re.sub(r'<[^>]*>', '', text)
    
    # 2. Noise Reduction: Strip citations like [1] or [src:123]
    text = re.sub(r'\[(?:src:)?\d+\]', '', text)
    
    # 3. Clean up whitespace
    text = text.replace('\n', ' ').strip()
    
    # 4. Tokenize and filter
    # Split by any non-word character EXCEPT those in the middle of words (like 30% or 18C)
    # Actually, let's split by space and then clean punctuation.
    tokens = text.split()
    compressed_tokens = []
    
    for token in tokens:
        # Clean punctuation from the edges for checking
        cleaned_token = re.sub(r'^[^\w%]+|[^\w%]+$', '', token.lower())
        
        # Check if it's a stop-word or preserved
        if cleaned_token in PRESERVED_WORDS:
            compressed_tokens.append(token)
        elif cleaned_token in STOP_WORDS:
            continue
        elif not cleaned_token:
            continue
        else:
            # If it contains digits (quantities/units) or is a normal word, keep it
            compressed_tokens.append(token)
            
    return " ".join(compressed_tokens)
