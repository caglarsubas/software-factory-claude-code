import pytest

from inventory.stock import Stock


def test_stock_never_goes_negative() -> None:
    stock = Stock()
    stock.add("kiwi", 5)
    stock.remove("kiwi", 5)
    assert stock.items["kiwi"].quantity == 0
    with pytest.raises(ValueError):
        stock.remove("kiwi", 1)
    assert stock.items["kiwi"].quantity == 0
