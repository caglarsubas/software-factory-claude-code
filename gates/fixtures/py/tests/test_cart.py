from cart import Line, total_cents


def test_sums_unit_price_times_quantity() -> None:
    assert total_cents([Line("a", 250, 2), Line("b", 100, 1)]) == 600


def test_empty_cart_costs_nothing() -> None:
    assert total_cents([]) == 0
