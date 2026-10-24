#!/usr/bin/env python3
"""Recompute every SHA-256 in gradle/verification-metadata.xml from the public repositories.

Run by .github/workflows/verify-maven-hashes.yml on a GITHUB-HOSTED runner, whenever the file
changes: the metadata is trust-on-first-use, written by whatever machine regenerated it, and
this checks it from a machine that is not that one (CISO review, PR #15). Standard library only.

Exit 1 when any artifact's hash differs from the file, or the artifact is in no repository.
"""
import concurrent.futures
import hashlib
import json
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


def https_only(url):
    # Every URL is one of REPOS plus a path from the metadata: never another scheme.
    if not url.startswith(tuple(f"{r}/" for r in REPOS)):
        raise ValueError(f"refusing a URL outside the pinned repositories: {url}")
    return url


def sha256_of(url):
    for attempt in range(4):
        try:
            # https to a pinned repository only (https_only); the content is hashed, never run.
            with urllib.request.urlopen(https_only(url), timeout=60) as r:  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
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


def fetch_text(url):
    try:
        with urllib.request.urlopen(https_only(url), timeout=60) as r:  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
            return r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def published_name(repo, base, name, version, file):
    """A Gradle Module Metadata variant file is RECORDED by its `name` (lifecycle-runtime-release.aar)
    but PUBLISHED at its `url` (lifecycle-runtime-android-2.9.1.aar): read the .module, as Gradle does."""
    module = fetch_text(f"{repo}/{base}/{name}-{version}.module")
    if module is None:
        return None
    for variant in json.loads(module).get("variants", []):
        for f in variant.get("files", []):
            if f.get("name") == file and f.get("url") and f["url"] != file:
                return f["url"]
    return None


def check(item):
    group, name, version, file, want = item
    base = f"{group.replace('.', '/')}/{name}/{version}"
    for repo in REPOS:
        got = sha256_of(f"{repo}/{base}/{file}")
        if got is None:
            url = published_name(repo, base, name, version, file)
            if url is None:
                continue
            got = sha256_of(f"{repo}/{base}/{url}")
            if got is None:
                continue
        return (item, repo, got == want, got)
    return (item, None, False, None)


def main(metadata):
    # No DTD at all, so no external entity and no entity expansion (XXE, "billion laughs"):
    # the verification metadata never has one. Checked before the standard parser sees it.
    with open(metadata, encoding="utf-8") as fh:
        text = fh.read()
    if "<!DOCTYPE" in text or "<!ENTITY" in text:
        print(f"{metadata} declares a DTD or an entity: refusing to parse it")
        return 1
    root = ET.fromstring(text)  # nosemgrep: python.lang.security.use-defused-xml-parse.use-defused-xml-parse
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
