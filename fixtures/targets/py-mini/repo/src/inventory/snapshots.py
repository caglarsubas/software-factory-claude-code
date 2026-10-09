import json
from pathlib import Path

from inventory.stock import Item, Stock


def save_snapshot(stock: Stock, path: Path) -> None:
    data = {sku: [i.quantity, i.reorder_level] for sku, i in stock.items.items()}
    path.write_text(json.dumps(data, sort_keys=True))


def load_snapshot(path: Path) -> Stock:
    data: dict[str, list[int]] = json.loads(path.read_text())
    return Stock({sku: Item(sku, qty, level) for sku, (qty, level) in data.items()})
