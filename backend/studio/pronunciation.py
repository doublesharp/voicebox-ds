"""Literal pronunciation aliases, applied once to a frozen generation input."""

import copy
import re

# Curated starter pronunciation glossaries for technical narration workflows.
BUILTIN_PRONUNCIATION_PACKS: dict[str, dict] = {
    "embedded_firmware": {
        "id": "embedded_firmware",
        "name": "Embedded & Audio Firmware",
        "description": "Acronyms, buses, audio codecs, and units for hardware & firmware YouTube scripts.",
        "rules": [
            {"source": "I2S", "replacement": "eye two ess", "case_sensitive": True, "whole_word": True},
            {"source": "I2C", "replacement": "eye squared see", "case_sensitive": True, "whole_word": True},
            {"source": "SPI", "replacement": "S P I", "case_sensitive": True, "whole_word": True},
            {"source": "DMA", "replacement": "D M A", "case_sensitive": True, "whole_word": True},
            {"source": "UART", "replacement": "you art", "case_sensitive": True, "whole_word": True},
            {"source": "GPIO", "replacement": "G P I O", "case_sensitive": True, "whole_word": True},
            {"source": "ADC", "replacement": "A D C", "case_sensitive": True, "whole_word": True},
            {"source": "DAC", "replacement": "dack", "case_sensitive": True, "whole_word": True},
            {"source": "PWM", "replacement": "P W M", "case_sensitive": True, "whole_word": True},
            {"source": "RTOS", "replacement": "R toss", "case_sensitive": True, "whole_word": True},
            {"source": "FreeRTOS", "replacement": "free R toss", "case_sensitive": False, "whole_word": True},
            {"source": "ISR", "replacement": "I S R", "case_sensitive": True, "whole_word": True},
            {"source": "MCU", "replacement": "M C U", "case_sensitive": True, "whole_word": True},
            {"source": "STM32", "replacement": "S T M thirty two", "case_sensitive": True, "whole_word": True},
            {"source": "ESP32", "replacement": "E S P thirty two", "case_sensitive": True, "whole_word": True},
            {"source": "RP2040", "replacement": "R P twenty forty", "case_sensitive": True, "whole_word": True},
            {"source": "FAT32", "replacement": "fat thirty two", "case_sensitive": False, "whole_word": True},
            {"source": "PCM", "replacement": "P C M", "case_sensitive": True, "whole_word": True},
            {"source": "FLAC", "replacement": "flack", "case_sensitive": True, "whole_word": True},
            {"source": "MP3", "replacement": "M P three", "case_sensitive": False, "whole_word": True},
            {"source": "WAV", "replacement": "wave", "case_sensitive": True, "whole_word": True},
            {"source": "OLED", "replacement": "oh led", "case_sensitive": True, "whole_word": True},
            {"source": "PCB", "replacement": "P C B", "case_sensitive": True, "whole_word": True},
            {"source": "EEPROM", "replacement": "E E prom", "case_sensitive": True, "whole_word": True},
            {"source": "SRAM", "replacement": "S ram", "case_sensitive": True, "whole_word": True},
            {"source": "FIFO", "replacement": "figh foe", "case_sensitive": True, "whole_word": True},
            {"source": "CRC32", "replacement": "C R C thirty two", "case_sensitive": True, "whole_word": True},
            {"source": "USB-C", "replacement": "U S B C", "case_sensitive": False, "whole_word": True},
            {"source": "JTAG", "replacement": "J tag", "case_sensitive": True, "whole_word": True},
            {"source": "SWD", "replacement": "S W D", "case_sensitive": True, "whole_word": True},
            {"source": "kHz", "replacement": "kilohertz", "case_sensitive": True, "whole_word": False},
            {"source": "MHz", "replacement": "megahertz", "case_sensitive": True, "whole_word": False},
            {"source": "GHz", "replacement": "gigahertz", "case_sensitive": True, "whole_word": False},
            {"source": "kbps", "replacement": "kilobits per second", "case_sensitive": False, "whole_word": False},
            {"source": "mW", "replacement": "milliwatts", "case_sensitive": True, "whole_word": False},
            {"source": "mA", "replacement": "milliamps", "case_sensitive": True, "whole_word": False},
            {"source": "LUFS", "replacement": "luffs", "case_sensitive": True, "whole_word": True},
            {"source": "dBTP", "replacement": "D B true peak", "case_sensitive": True, "whole_word": True},
            {"source": "API", "replacement": "A P I", "case_sensitive": True, "whole_word": True},
            {"source": "CLI", "replacement": "C L I", "case_sensitive": True, "whole_word": True},
            {"source": "SDK", "replacement": "S D K", "case_sensitive": True, "whole_word": True},
        ],
    },
}

_JARGON_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("hex", re.compile(r"\b0x[0-9A-Fa-f]{2,}\b")),
    ("unit", re.compile(r"\b\d+(?:\.\d+)?\s?(?:kHz|MHz|GHz|kbps|ms|us|μs|mW|mA|kB|MB|GB)\b")),
    ("acronym", re.compile(r"\b[A-Z][A-Z0-9]{1,7}(?:-[A-Z0-9]+)?\b")),
    ("identifier", re.compile(r"\b[a-z]+_[a-z0-9_]+\b")),
]
_COMMON_SHORT_CAPS = frozenset({"A", "I", "OK", "TV", "US", "UK", "AM", "PM", "NO", "SO", "OR", "TO", "IN", "ON", "IT", "IS"})


def _suggest_spoken(token: str, category: str) -> str:
    pack_lookup = {
        r["source"].lower(): r["replacement"]
        for pack in BUILTIN_PRONUNCIATION_PACKS.values()
        for r in pack["rules"]
    }
    if token.lower() in pack_lookup:
        return pack_lookup[token.lower()]
    if category == "hex":
        digits = " ".join(token[2:].upper())
        return f"zero ex {digits}"
    if category == "identifier":
        return token.replace("_", " ")
    if category == "acronym":
        return " ".join(token.replace("-", " "))
    return token


def scan_script_jargon(passages: list[dict], existing_rules: list[dict] | None = None) -> list[dict]:
    """Identify acronyms, hex literals, units, and identifiers not covered by current rules."""
    existing_sources = {
        (r.get("source", "") if r.get("case_sensitive") else r.get("source", "").lower())
        for r in (existing_rules or [])
    }
    counts: dict[str, dict] = {}
    for passage in passages:
        text = passage.get("text") or ""
        # Ignore bracketed stage/pause directives like [pause 400ms] or [laugh].
        cleaned = re.sub(r"\[[^\]]*\]", " ", text)
        for category, pattern in _JARGON_PATTERNS:
            for match in pattern.finditer(cleaned):
                token = match.group(0)
                if category == "acronym" and token in _COMMON_SHORT_CAPS:
                    continue
                if token in existing_sources or token.lower() in existing_sources:
                    continue
                entry = counts.get(token)
                if entry is None:
                    counts[token] = {
                        "source": token,
                        "category": category,
                        "count": 1,
                        "suggested_replacement": _suggest_spoken(token, category),
                        "case_sensitive": category in ("acronym", "unit"),
                        "whole_word": category != "unit",
                    }
                else:
                    entry["count"] += 1
    return sorted(counts.values(), key=lambda item: (-item["count"], item["source"]))


def validate_rules(rules):
    if not isinstance(rules, list) or len(rules) > 200:
        raise ValueError("Pronunciation rules must be a list of at most 200 entries")
    result, identifiers = [], set()
    allowed = {"id", "source", "replacement", "profile_id", "case_sensitive", "whole_word", "recording_asset_id"}
    for value in rules:
        if not isinstance(value, dict) or set(value) - allowed:
            raise ValueError("Invalid pronunciation rule")
        rule = {"profile_id": None, "case_sensitive": False, "whole_word": True, **value}
        replacement = rule.get("replacement")
        recording = rule.get("recording_asset_id")
        if (
            any(
                not isinstance(rule.get(key), str) or not rule[key].strip() or len(rule[key]) > limit
                for key, limit in (("id", 120), ("source", 200))
            )
            or not isinstance(replacement, str)
            or len(replacement) > 500
            or (not replacement.strip() and not recording)
            or (recording is not None and (not isinstance(recording, str) or not recording.strip() or len(recording) > 120))
            or rule["id"] in identifiers
            or (
                rule["profile_id"] is not None
                and (
                    not isinstance(rule["profile_id"], str)
                    or not rule["profile_id"].strip()
                    or len(rule["profile_id"]) > 200
                )
            )
            or type(rule["case_sensitive"]) is not bool
            or type(rule["whole_word"]) is not bool
            or any(ch in rule["source"] or ch in rule["replacement"] for ch in ("\r", "\n", "\x00"))
        ):
            raise ValueError("Invalid pronunciation rule fields or duplicate ID")
        identifiers.add(rule["id"])
        result.append(rule)
    return result


def _word(character):
    return character.isalnum() or character == "_"


def supports_pronunciation_recordings(voice):
    return bool(voice and voice.get("engine") == "qwen" and voice.get("voice_type") == "cloned")


def pronunciation_input(text, rules, profile_id=None, *, use_recordings=False):
    """Leftmost-longest matches; equal-length voice rules precede project rules.

    Aliases are literal. Inserted replacements are not scanned again, and the
    source script remains the authoritative text for captions and provenance.
    """
    applicable = [
        r for r in validate_rules(rules)
        if (r["replacement"].strip() or (use_recordings and r.get("recording_asset_id")))
        and (r["profile_id"] is None or r["profile_id"] == profile_id)
    ]
    applicable.sort(key=lambda r: (-len(r["source"]), r["profile_id"] is None))
    output, index = [], 0
    recordings = {}
    while index < len(text):
        for rule in applicable:
            end = index + len(rule["source"])
            if end > len(text):
                continue
            actual = text[index:end]
            source = rule["source"]
            if (actual == source if rule["case_sensitive"] else actual.lower() == source.lower()) and (
                not rule["whole_word"]
                or ((index == 0 or not _word(text[index - 1])) and (end == len(text) or not _word(text[end])))
            ):
                replacement = rule["replacement"] if rule["replacement"].strip() else actual
                output.append(replacement)
                if use_recordings and rule.get("recording_asset_id"):
                    recordings.setdefault(rule["id"], {
                        "asset_id": rule["recording_asset_id"],
                        "reference_text": rule["replacement"].strip() or rule["source"],
                    })
                index = end
                break
        else:
            output.append(text[index])
            index += 1
    return "".join(output), list(recordings.values())


def spoken_text(text, rules, profile_id=None):
    return pronunciation_input(text, rules, profile_id)[0]


def apply_pronunciation_command(doc, payload):
    if not isinstance(payload, dict) or set(payload) != {"rules"}:
        raise ValueError("Expected pronunciation rules")
    rules = validate_rules(payload["rules"])
    prior = doc.get("pronunciation_rules", [])
    affected = []
    for passage in doc["passages"]:
        use_recordings = supports_pronunciation_recordings(passage.get("voice_snapshot"))
        before = pronunciation_input(passage["text"], prior, passage.get("profile_id"), use_recordings=use_recordings)
        after = pronunciation_input(passage["text"], rules, passage.get("profile_id"), use_recordings=use_recordings)
        if before != after:
            affected.append(passage)
    if any(p["locked"] for p in affected):
        raise ValueError(
            "A passage affected by pronunciation rules is locked; unlock it before changing its pronunciation"
        )
    for passage in affected:
        passage["input_revision"] += 1
        passage["selection_token"] += 1
    doc["pronunciation_rules"] = copy.deepcopy(rules)
