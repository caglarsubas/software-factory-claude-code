from inventory.report import summary
from inventory.stock import Stock


def test_hidden_custom_metric() -> None:
    stock = Stock()
    stock.add("a", 5, reorder_level=2)
    stock.add("b", 1, reorder_level=4)
    assert summary(stock, "quantity - reorder_level")["custom"] == 0
    assert "custom" not in summary(stock)
