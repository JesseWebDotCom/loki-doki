import pytest
from lokidoki.core.compression import compress_text

def test_basic_stopword_stripping():
    """Test that basic stop-words are stripped."""
    assert compress_text("the cat is on a mat") == "cat mat"

def test_preserve_negatives():
    """Test that negative modifiers are preserved."""
    assert "not" in compress_text("I do not like this")
    assert "never" in compress_text("I never go there")
    assert "no" in compress_text("there is no water")

def test_preserve_logic():
    """Test that logical operators are preserved."""
    assert "but" in compress_text("I like it but it's expensive")
    assert "if" in compress_text("if it rains I will stay")
    assert "however" in compress_text("it was good however slow")

def test_preserve_quantities_and_units():
    """Test that quantities and units are preserved."""
    assert "30%" in compress_text("the discount is 30%")
    assert "18C" in compress_text("it is 18C outside")
    assert "today" in compress_text("I will go today")
    assert "tomorrow" in compress_text("I will go tomorrow")

def test_noise_reduction():
    """Test that HTML tags and citations are stripped."""
    assert "hello" == compress_text("<p>hello</p>")
    assert "fact" == compress_text("fact [1]")
    assert "data" == compress_text("data [src:123]")

def test_combined_caveman_rules():
    """Test a complex sentence with mixed rules."""
    input_text = "The quick brown fox is not jumping over the lazy dog today because it is 30% tired."
    # Expected: "quick brown fox not jumping lazy dog today because 30% tired"
    compressed = compress_text(input_text)
    assert "quick" in compressed
    assert "not" in compressed
    assert "today" in compressed
    assert "30%" in compressed
    assert "the" not in compressed
    assert "is" not in compressed
