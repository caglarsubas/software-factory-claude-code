import pytest

from inventory.stock import Stock


def test_hidden_remove_unknown() -> None:
    stock = Stock()
    stock.add("apple", 1)
    with pytest.raises(ValueError, match="ghost"):
        stock.remove("ghost", 1)
    assert stock.remove("apple", 1).quantity == 0
