from moneyfmt import group_thousands


def test_group_thousands() -> None:
    assert group_thousands(1234567) == "1,234,567"
    assert group_thousands(12) == "12"
