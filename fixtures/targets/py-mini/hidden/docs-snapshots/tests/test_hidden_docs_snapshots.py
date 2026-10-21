from pathlib import Path


def test_hidden_snapshot_format_documented() -> None:
    usage = (Path(__file__).parent.parent / "docs" / "usage.md").read_text()
    snapshots = usage.split("## Snapshots")[1]
    assert "quantity" in snapshots
    assert "reorder_level" in snapshots
