#!/usr/bin/env python3
"""Check bilingual changelog structure and paired changes in a pull request."""
import re
import subprocess
import sys
from pathlib import Path

FILES = ("CHANGELOG.md", "CHANGELOG.zh-CN.md")
CATEGORIES = {"Added": "新增", "Changed": "变更", "Fixed": "修复", "Removed": "移除", "Upgrade": "升级"}


def structure(path, chinese=False):
    result = []
    reverse = {v: k for k, v in CATEGORIES.items()}
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if line.startswith("## "):
            result.append(("release", line[3:]))
        elif line.startswith("### "):
            category = line[4:]
            result.append(("category", reverse.get(category, category) if chinese else category))
        elif re.match(r"^(?:- |\d+\. )", line):
            result.append(("entry",))
    return result


def main():
    if structure(FILES[0]) != structure(FILES[1], chinese=True):
        sys.exit("Changelog versions, categories or entry counts differ; update both translations.")
    if len(sys.argv) > 1:
        changed = subprocess.check_output(
            ["git", "diff", "--name-only", "--no-renames", sys.argv[1], "HEAD", "--", *FILES], text=True
        ).splitlines()
        if len(changed) == 1:
            sys.exit("Update both CHANGELOG.md and CHANGELOG.zh-CN.md in the same PR.")
    print("Changelog synchronization checks passed (translation accuracy requires review).")


if __name__ == "__main__":
    main()
