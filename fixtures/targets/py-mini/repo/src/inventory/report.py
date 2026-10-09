from inventory.stock import Stock


def summary(stock: Stock) -> dict[str, int]:
    return {
        "skus": len(stock.items),
        "units": sum(item.quantity for item in stock.items.values()),
    }
