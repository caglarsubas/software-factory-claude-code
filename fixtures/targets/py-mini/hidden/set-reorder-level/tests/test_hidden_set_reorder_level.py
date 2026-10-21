import pytest

from inventory.stock import Stock


def test_hidden_set_reorder_level() -> None:
    stock = Stock()
    stock.add("plum", 3, reorder_level=1)
    stock.set_reorder_level("plum", 4)
    assert stock.items["plum"].reorder_level == 4
    with pytest.raises(ValueError):
        stock.set_reorder_level("plum", -2)
    with pytest.raises(ValueError):
        stock.set_reorder_level("nope", 2)
