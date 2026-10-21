"""moneyfmt: number formatting, vendored. See README.md."""


def group_thousands(n: int) -> str:
    """The integer with commas between groups of three digits: "1,234,567"."""
    return f"{n:,}"
