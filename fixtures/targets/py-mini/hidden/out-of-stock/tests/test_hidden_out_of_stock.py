from inventory.report import out_of_stock
from inventory.stock import Stock


def test_hidden_out_of_stock() -> None:
    stock = Stock()
    stock.add("zest", 0)
    stock.add("apple", 3)
    stock.add("bean", 2)
    stock.remove("bean", 5)
    assert out_of_stock(stock) == ["bean", "zest"]
    assert out_of_stock(Stock()) == []
