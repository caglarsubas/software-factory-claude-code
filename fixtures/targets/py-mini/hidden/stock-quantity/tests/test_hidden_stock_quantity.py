from inventory.stock import Stock


def test_hidden_quantity() -> None:
    stock = Stock()
    stock.add("kiwi", 7)
    stock.remove("kiwi", 2)
    assert stock.quantity("kiwi") == 5
    assert stock.quantity("mango") == 0
