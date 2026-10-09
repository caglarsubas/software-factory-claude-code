import pytest

from inventory.stock import Stock


def test_add_and_remove() -> None:
    stock = Stock()
    stock.add("apple", 10)
    assert stock.remove("apple", 3).quantity == 7


def test_add_rejects_negative_quantities() -> None:
    with pytest.raises(ValueError):
        Stock().add("apple", -1)
