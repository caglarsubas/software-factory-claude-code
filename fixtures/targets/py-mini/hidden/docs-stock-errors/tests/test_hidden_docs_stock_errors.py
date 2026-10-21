from pathlib import Path


def test_hidden_negative_addition_documented() -> None:
    usage = (Path(__file__).parent.parent / "docs" / "usage.md").read_text()
    stock_section = usage.split("## Stock")[1].split("## ")[0]
    assert "ValueError" in stock_section
