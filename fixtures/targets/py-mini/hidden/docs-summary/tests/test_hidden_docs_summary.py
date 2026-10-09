from pathlib import Path


def test_usage_guide_documents_summary_keys() -> None:
    text = (Path(__file__).parent.parent / "docs" / "usage.md").read_text()
    reports = text.split("## Reports")[1].split("## Snapshots")[0]
    assert "`skus`" in reports
    assert "`units`" in reports
