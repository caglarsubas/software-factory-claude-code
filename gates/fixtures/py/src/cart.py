from dataclasses import dataclass


@dataclass(frozen=True)
class Line:
    sku: str
    unit_cents: int
    quantity: int


def total_cents(lines: list[Line]) -> int:
    return sum(line.unit_cents * line.quantity for line in lines)
