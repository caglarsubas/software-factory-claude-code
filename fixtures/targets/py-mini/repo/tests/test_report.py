from inventory.report import summary
from inventory.stock import Stock


def test_summary_counts_skus_and_units() -> None:
    stock = Stock()
    stock.add("apple", 3)
    stock.add("pear", 4)
    assert summary(stock) == {"skus": 2, "units": 7}
