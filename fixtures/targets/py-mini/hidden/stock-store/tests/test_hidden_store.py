from pathlib import Path

from inventory.stock import Stock
from inventory.store import load, open_store, save


def test_stock_survives_a_reopen(tmp_path: Path) -> None:
    path = str(tmp_path / "inventory.db")
    stock = Stock()
    stock.add("apple", 3, reorder_level=5)
    stock.add("banana", 12)
    db = open_store(path)
    save(db, stock)
    db.close()
    again = open_store(path)
    assert load(again) == stock
    again.close()


def test_an_empty_store_loads_empty(tmp_path: Path) -> None:
    db = open_store(str(tmp_path / "empty.db"))
    assert load(db) == Stock()
    db.close()
