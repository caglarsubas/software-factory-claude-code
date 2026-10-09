from pathlib import Path

from inventory.snapshots import load_snapshot, save_snapshot
from inventory.stock import Stock


def test_round_trip(tmp_path: Path) -> None:
    stock = Stock()
    stock.add("apple", 5, reorder_level=2)
    save_snapshot(stock, tmp_path / "snap.json")
    loaded = load_snapshot(tmp_path / "snap.json")
    assert loaded.items["apple"].quantity == 5
    assert loaded.items["apple"].reorder_level == 2
