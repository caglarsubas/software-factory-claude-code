from inventory.report import low_stock
from inventory.stock import Stock


def test_low_stock_report() -> None:
    stock = Stock()
    stock.add("zucchini", 0, reorder_level=1)
    stock.add("banana", 10, reorder_level=10)
    stock.add("cherry", 11, reorder_level=10)
    stock.add("apple", 1, reorder_level=3)
    assert low_stock(stock) == ["apple", "banana", "zucchini"]
    assert low_stock(Stock()) == []
