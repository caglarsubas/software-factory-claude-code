from inventory.report import units_label
from inventory.stock import Stock


def test_hidden_units_label() -> None:
    stock = Stock()
    stock.add("a", 1_000_000)
    stock.add("b", 5)
    assert units_label(stock) == "1,000,005 units"
    assert units_label(Stock()) == "0 units"
