"""Parsing of human-written durations, for the scheduler's config file."""


def parse_duration(text: str) -> int:
    """Return the number of seconds in a duration such as "1h30m", "90s" or "2h 5m 10s".

    Units are h, m and s, each used at most once and in that order, with optional spaces
    between the parts. A plain number with no unit is seconds. Case does not matter.
    Anything else (an empty string, an unknown unit, a unit twice, a negative number)
    raises ValueError.
    """
    raise NotImplementedError
