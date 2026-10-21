from inventory.report import skus_with_prefix
from inventory.stock import Stock


def test_hidden_skus_with_prefix() -> None:
    stock = Stock()
    for sku in ["b-2", "a-1", "b-1", "c-1"]:
        stock.add(sku, 1)
    assert skus_with_prefix(stock, "b-") == ["b-1", "b-2"]
    assert skus_with_prefix(stock, "") == ["a-1", "b-1", "b-2", "c-1"]
    assert skus_with_prefix(Stock(), "a") == []
