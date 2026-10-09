import pickle
from pathlib import Path

from inventory.snapshots import load_snapshot


def test_legacy_pickle_snapshot(tmp_path: Path) -> None:
    path = tmp_path / "legacy.pkl"
    path.write_bytes(pickle.dumps({"pear": (7, 3), "fig": (0, 2)}))
    stock = load_snapshot(path)
    assert stock.items["pear"].quantity == 7
    assert stock.items["fig"].reorder_level == 2
