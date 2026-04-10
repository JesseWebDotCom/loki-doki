from __future__ import annotations

import re
from datetime import datetime

from num2words import num2words


_TITLE_MAP = {
    "dr.": "Doctor",
    "mr.": "Mister",
    "mrs.": "Missus",
    "ms.": "Miss",
    "etc.": "et cetera",
    "approx.": "approximately",
}
_UNIT_MAP = {
    "km": "kilometers",
    "lbs": "pounds",
    "oz": "ounces",
}
_MONTHS = {
    1: "January",
    2: "February",
    3: "March",
    4: "April",
    5: "May",
    6: "June",
    7: "July",
    8: "August",
    9: "September",
    10: "October",
    11: "November",
    12: "December",
}


def normalize_for_speech(
    text: str,
    *,
    pronunciation_fixes: dict[str, str] | None = None,
) -> str:
    out = str(text or "").strip()
    if not out:
        return ""
    if pronunciation_fixes:
        from lokidoki.core.pronunciation_fixes import apply_pronunciation_fixes

        out = apply_pronunciation_fixes(out, pronunciation_fixes)
    out = _normalize_temperatures(out)
    out = _strip_artifacts(out)
    out = _normalize_dates_and_times(out)
    out = _normalize_phone_numbers(out)
    out = _normalize_zip_codes(out)
    out = _normalize_urls_and_emails(out)
    out = _expand_abbreviations(out)
    out = _normalize_currency_percent_and_ordinals(out)
    out = _normalize_plain_numbers(out)
    out = _normalize_symbols(out)
    return _final_cleanup(out)


def _normalize_temperatures(text: str) -> str:
    out = re.sub(r"(-?\d+(?:\.\d+)?)\s*°\s*([CF])\b", _replace_degree_temperature, text, flags=re.IGNORECASE)
    out = re.sub(r"(-?\d+(?:\.\d+)?)\s+degrees?\s+([CF])\b", _replace_degree_temperature, out, flags=re.IGNORECASE)
    return out


def _strip_artifacts(text: str) -> str:
    out = re.sub(r"\[src:\d+\]", "", text, flags=re.IGNORECASE)
    out = re.sub(r"\((https?://[^)]+)\)", "", out, flags=re.IGNORECASE)
    out = re.sub(r"https?://\S+", "link", out, flags=re.IGNORECASE)
    out = re.sub(r"`([^`]+)`", r"\1", out)
    out = re.sub(r"[*_~>]+", " ", out)
    out = re.sub(r"[^\x00-\x7F]+", " ", out)
    out = re.sub(r"([!?.,])\1+", r"\1", out)
    return out


def _normalize_urls_and_emails(text: str) -> str:
    out = re.sub(
        r"\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+)\.([A-Za-z]{2,})\b",
        lambda m: f"{m.group(1)} at {m.group(2)} dot {m.group(3)}",
        text,
    )
    out = re.sub(r"(?<!\d)\b(?:/[^/\s]+){2,}\b", " path ", out)
    return out


def _expand_abbreviations(text: str) -> str:
    out = text
    for src, target in _TITLE_MAP.items():
        out = re.sub(rf"\b{re.escape(src)}", target, out, flags=re.IGNORECASE)
    out = re.sub(r"\bvs\.?\b", "versus", out, flags=re.IGNORECASE)
    for unit, target in _UNIT_MAP.items():
        out = re.sub(rf"\b(\d+(?:\.\d+)?)\s*{unit}\b", rf"\1 {target}", out, flags=re.IGNORECASE)
    return out


def _normalize_dates_and_times(text: str) -> str:
    out = re.sub(r"\b(\d{4})-(\d{2})-(\d{2})\b", _replace_iso_date, text)
    out = re.sub(r"\b(\d{1,2})/(\d{1,2})/(\d{4})\b", _replace_slash_date, out)
    out = re.sub(r"\b(\d{1,2}):(\d{2})\s*([AP]M)\b", _replace_time, out, flags=re.IGNORECASE)
    out = re.sub(r"\b(\d{1,2})-(\d{1,2})\b(?=\s+(?:shift|job|work|schedule|hours)\b)", _replace_range, out, flags=re.IGNORECASE)
    return out


def _normalize_phone_numbers(text: str) -> str:
    return re.sub(r"(?<!\d)(\d{3})-(\d{4})(?!\d)", lambda m: _speak_digits(m.group(1)) + ", " + _speak_digits(m.group(2)), text)


def _normalize_zip_codes(text: str) -> str:
    return re.sub(r"\b(0\d{4})\b", lambda m: _speak_digits(m.group(1)), text)


def _normalize_currency_percent_and_ordinals(text: str) -> str:
    out = re.sub(r"\$(\d+)(?:\.(\d{2}))?\b", _replace_currency, text)
    out = re.sub(r"(\d+(?:\.\d+)?)%", _replace_percent, out)
    out = re.sub(r"\b(\d+)(st|nd|rd|th)\b", _replace_ordinal, out, flags=re.IGNORECASE)
    return out


def _normalize_plain_numbers(text: str) -> str:
    out = re.sub(r"#(\d+)\b", lambda m: f"number {_number_words(int(m.group(1)))}", text)
    out = re.sub(r"\b(\d{1,3}(?:,\d{3})+)\b", lambda m: _number_words(int(m.group(1).replace(',', ''))), out)
    out = re.sub(r"\b(\d{4})\b", _replace_year_like, out)
    out = re.sub(r"\b(\d+\.\d+|\d+)\b", _replace_cardinal, out)
    return out


def _normalize_symbols(text: str) -> str:
    out = text.replace("&", " and ")
    out = re.sub(r"(?<=\w)\+(?=\w)|\s+\+\s+", " plus ", out)
    out = re.sub(r"\s+=\s+", " equals ", out)
    out = out.replace("@", " at ")
    return out


def _final_cleanup(text: str) -> str:
    out = re.sub(r"\s+", " ", text).strip()
    out = re.sub(r"\s+([,.!?])", r"\1", out)
    return out


def _replace_iso_date(match: re.Match[str]) -> str:
    year, month, day = map(int, match.groups())
    return _spoken_date(year, month, day)


def _replace_slash_date(match: re.Match[str]) -> str:
    month, day, year = map(int, match.groups())
    return _spoken_date(year, month, day)


def _replace_time(match: re.Match[str]) -> str:
    hour = int(match.group(1))
    minute = int(match.group(2))
    meridiem = match.group(3).upper()
    if minute == 0:
        minute_words = "o'clock"
    elif minute < 10:
        minute_words = f"oh {_number_words(minute)}"
    else:
        minute_words = _number_words(minute)
    return f"{_number_words(hour)} {minute_words} {meridiem}"


def _replace_range(match: re.Match[str]) -> str:
    return f"{_number_words(int(match.group(1)))} to {_number_words(int(match.group(2)))}"


def _replace_currency(match: re.Match[str]) -> str:
    dollars = int(match.group(1))
    cents = int(match.group(2) or "0")
    if cents:
        return f"{_number_words(dollars)} dollars and {_number_words(cents)} cents"
    return f"{_number_words(dollars)} dollars"


def _replace_percent(match: re.Match[str]) -> str:
    value = match.group(1)
    if "." in value:
        whole, frac = value.split(".", 1)
        return f"{_number_words(int(whole))} point {_speak_digits(frac)} percent"
    return f"{_number_words(int(value))} percent"


def _replace_ordinal(match: re.Match[str]) -> str:
    return num2words(int(match.group(1)), to="ordinal")


def _replace_degree_temperature(match: re.Match[str]) -> str:
    value = match.group(1)
    unit = match.group(2).upper()
    if "." in value:
        whole, frac = value.split(".", 1)
        spoken_value = f"{_number_words(int(whole))} point {_speak_digits(frac)}"
    else:
        spoken_value = _number_words(int(value))
    unit_name = "Celsius" if unit == "C" else "Fahrenheit"
    return f"{spoken_value} degrees {unit_name}"


def _replace_year_like(match: re.Match[str]) -> str:
    year = int(match.group(1))
    return _speak_year(year)


def _replace_cardinal(match: re.Match[str]) -> str:
    value = match.group(1)
    if "." in value:
        whole, frac = value.split(".", 1)
        return f"{_number_words(int(whole))} point {_speak_digits(frac)}"
    return _number_words(int(value))


def _spoken_date(year: int, month: int, day: int) -> str:
    try:
        datetime(year, month, day)
    except ValueError:
        return f"{month}/{day}/{year}"
    return f"{_MONTHS[month]} {num2words(day, to='ordinal')}, {_speak_year(year)}"


def _number_words(value: int) -> str:
    return num2words(value).replace(",", "")


def _speak_digits(value: str) -> str:
    return " ".join(_number_words(int(ch)) for ch in str(value) if ch.isdigit())


def _speak_year(year: int) -> str:
    if 1100 <= year <= 2099:
        hi, lo = year // 100, year % 100
        if lo == 0:
            return f"{_number_words(hi)} hundred"
        if lo < 10:
            return f"{_number_words(hi)} oh {_number_words(lo)}"
        return f"{_number_words(hi)} {_number_words(lo)}"
    return _number_words(year)
