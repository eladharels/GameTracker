#!/usr/bin/env python3
"""Recompute every SHA-256 in gradle/verification-metadata.xml from the public repositories.

Run by .github/workflows/verify-maven-hashes.yml on a GITHUB-HOSTED runner, whenever the file
changes: the metadata is trust-on-first-use, written by whatever machine regenerated it, and
this checks it from a machine that is not that one (CISO review, PR #15). Standard library only.

Exit 1 when any artifact's hash differs from the file, or the artifact is in no repository.
"""
import concurrent.futures
import hashlib
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

REPOS = [
    "https://dl.google.com/dl/android/maven2",   # androidx, com.android, com.google.android
    "https://repo.maven.apache.org/maven2",
    "https://plugins.gradle.org/m2",             # plugin markers and plugin-only artifacts
]
NS = {"v": "https://schema.gradle.org/dependency-verification"}


def sha256_of(url):
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                h = hashlib.sha256()
                for chunk in iter(lambda: r.read(1 << 16), b""):
                    h.update(chunk)
                return h.hexdigest()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code == 429 or e.code >= 500:
                time.sleep(2 ** attempt)
                continue
            raise
        except (urllib.error.URLError, TimeoutError):
            time.sleep(2 ** attempt)
    raise RuntimeError(f"could not fetch {url}")


def check(item):
    group, name, version, file, want = item
    path = f"{group.replace('.', '/')}/{name}/{version}/{file}"
    for repo in REPOS:
        got = sha256_of(f"{repo}/{path}")
        if got is None:
            continue
        return (item, repo, got == want, got)
    return (item, None, False, None)


def main(metadata):
    root = ET.parse(metadata).getroot()
    items = []
    for comp in root.findall("v:components/v:component", NS):
        for art in comp.findall("v:artifact", NS):
            for sha in art.findall("v:sha256", NS):
                items.append((comp.get("group"), comp.get("name"), comp.get("version"), art.get("name"), sha.get("value")))
    if len(items) < 100:
        print(f"only {len(items)} hashes parsed from {metadata}: the parse is broken")
        return 1
    bad = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        for item, repo, ok, got in pool.map(check, items):
            if not ok:
                bad.append((item, repo, got))
    for (g, n, v, f, want), repo, got in bad:
        where = repo or "no repository"
        print(f"MISMATCH {g}:{n}:{v} {f}: file says {want}, {where} serves {got}")
    print(f"{len(items) - len(bad)} of {len(items)} hashes recomputed and equal")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "mobile/gradle/verification-metadata.xml"))
