from dataclasses import dataclass, field


@dataclass
class Item:
    sku: str
    quantity: int
    reorder_level: int = 0


@dataclass
class Stock:
    items: dict[str, Item] = field(default_factory=dict)

    def add(self, sku: str, quantity: int, reorder_level: int = 0) -> Item:
        if quantity < 0:
            raise ValueError("quantity must not be negative")
        item = self.items.setdefault(sku, Item(sku, 0, reorder_level))
        item.quantity += quantity
        return item

    def remove(self, sku: str, quantity: int) -> Item:
        item = self.items[sku]
        item.quantity -= quantity
        return item
