`Stock.remove` raises a bare `KeyError` for a SKU the stock does not hold. Make it raise `ValueError` with a message that names the SKU instead, and add a test.
