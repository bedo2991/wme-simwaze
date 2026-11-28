"""Fetch official Wazer mood icons from the Waze Community Brand Refresh pages
and embed compact 48px PNG data URIs into src/assets/moods.ts.
"""

from __future__ import annotations

import base64
import concurrent.futures
import hashlib
import os
import re
import struct
import time
import urllib.request

MOODS_URL = "https://sites.google.com/view/social-media-community/graphic-assets/after-brand-refresh/moods"
CAMPAIGN_WAZERS_URL = "https://sites.google.com/view/social-media-community/graphic-assets/after-brand-refresh/campaign-specific-wazers"
MIN_EXPECTED_COUNT = 50
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

# Specific assets excluded per user request (matched both by URL token and =w48 SHA-256,
# since Google Sites mints per-session tokens for sitesv-images-rt URLs).
EXCLUDED_URL_TOKENS: frozenset[str] = frozenset(
    {
        # #07: twin Wazers graphic (48x28)
        "APXyLQcGkwThINQ-fy-FcMoSsjFjtVo6zXh5zP0FbD8wJGoCli9W-Gq4lp-FmaRLrzxWWy07VBfY6DxqX-tUwObD9yuVZH8_quQ02KN6CFh77fv2a3KGPdAYLeplpo1-T1UG7KtBQSDit5_gob9hSOuOoBtOyoANoziuwZ7A8DZBTuWG_Du0B6vDb-EcezAeRhDYtBQtFufa5gSKlvWWVae_vFxysfSsmXSxVsFf",
        # #48: sparse non-Wazer figure (48x48)
        "APXyLQd80Z49Eik0bi3Pq3_DWhEQ5ZaMGsLwk9wj13VUMcHnxIxycGbKLYXhh6oHvuQxl5Yyk2D525nhX9QcPpc4wCwYwIhlPvT9IOhInjhhsFPNI1uYuULRkFh7k6TBAUqe-fSjECT_WGwhg4sOE_D5VlEaCwy8xYDdLQlu5qY8fG9RagpjDg4amQ",
        # #61: wheelless figure at end of page (48x49)
        "APXyLQe4ei-YIAdpjPBghn8lfurmss7Ln2OkTqwuQ-Zg4az0aw3U68WYndFBcrNn_blLHvAIr5XocN2-F-3BzVTD0SwvS1a3vu7xGvy42vzuQhjL-6J7YlwXwsVWgrseFqkoLyNfRZEnig6_5x3Mdu25qCmRGmTz-YGPT0-JmuPI8nb-f6despY81Fb-b0MvSNFoMur75wDmdneUek_6D3FNZMRHslrHKq880bnj",
    }
)

EXCLUDED_W48_SHA256: frozenset[str] = frozenset(
    {
        # #07 (48x28 twin Wazers graphic)
        "577acde2000ad6a5977246996f590a7dc145670c07ddf86580320b115d3a50a7",
        # #48 (48x48 sparse non-Wazer figure)
        "c9fe08af32f55d663ef2bdfdd408c9902fb8dffde8959f3f9a7ea6e0d9ae0e8c",
        # #61 (48x49 wheelless figure at end of page)
        "8cdbd886c2bf120a2947a23373103ba7a93cb10f7a698424f4f779f4bfd9338e",
    }
)

# Seasonal Santa moods from Campaign Specific Wazers ("Drive with Santa - December 2021")
SANTA_MOOD_SPECS: tuple[tuple[str, str, str], ...] = (
    (
        "Happy Santa",
        "APXyLQc8g3uQ105Q1voeBpLVLnAio89HeBQKKXkGfpvIdN71uipNsKjwMg87mPD4D4ixrDQpsWo8yfjNimjhRRf1vqu3gEf5rf5Fsc2KgXbN0L0h-rU4rg6G4P2MVt4-eNosEjJ8gGaIrLbKm75SWUkrSY6r_uavktiBK0WloeuEAOF7nfFVR-Lhta5wYf0Rp0u0MhzTLDf6QRLcM63kVmga6a1k9r8-B24v0OtU",
        "7aa36382a96b12c605ed49a1c9bd12c9efe51dbccc55ae3beca51b8b50bdd193",
    ),
    (
        "Not happy Santa",
        "APXyLQcfP1BMBg2EbGzyD8l6eiUC3kTCD_ho8RyR2RWl-MpZ6sgDTCnAARxDGMDIgn4OfdIfcrk2fXc1ID9L0TQNTaimRNNTfpCV-_lPNU6mh1SJslcDGnQCc59wBkJ--wVtU3K6QVLMJhXxHqDPR_eGc16cn0FqTmFQTUMJN6JAirkz8akIU6PFnITIQ09wHgFdoncvZSLFruyxe0uMN5cRVFxgw2ANZdEP6Yow",
        "6bd8a43a0648eef1df67d393753d3cb0f01f0b31aceb469a8c8898c766a38978",
    ),
)


def fetch_bytes(url: str, attempts: int = 3) -> bytes:
    """Fetch raw bytes from URL with retries and short backoff."""
    last_exc: Exception | None = None
    for attempt in range(attempts):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return resp.read()
        except Exception as exc:
            last_exc = exc
            if attempt + 1 < attempts:
                time.sleep(0.4 * (attempt + 1))
    assert last_exc is not None
    raise last_exc


def png_dimensions(data: bytes) -> tuple[int, int] | None:
    """Return (width, height) if data is a valid PNG header, else None."""
    if len(data) < 26 or data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    w, h = struct.unpack(">II", data[16:24])
    return (w, h)


def extract_candidate_urls(html: str) -> list[str]:
    """Extract ordered, deduplicated content image URLs from a Google Sites page."""
    srcs: list[str] = []
    for tag_match in re.finditer(r'<img\b[^>]*class="[^"]*CENy8b[^"]*"[^>]*>', html):
        src_match = re.search(r'src="([^"]+)"', tag_match.group(0))
        if src_match:
            srcs.append(src_match.group(1))

    if not srcs:
        srcs = [
            m.group(1)
            for m in re.finditer(r'<img[^>]+src="([^"]+)"', html)
            if "w16383" not in m.group(1) and "sitesv-images-rt" in m.group(1)
        ]

    seen: set[str] = set()
    unique_srcs: list[str] = []
    for s in srcs:
        if s not in seen:
            seen.add(s)
            unique_srcs.append(s)
    return unique_srcs


def extract_rt_token(url: str) -> str:
    """Extract the sitesv-images-rt token from a Google Sites image URL."""
    m = re.search(r"/sitesv-images-rt/([^=?]+)", url)
    return m.group(1) if m else ""


def download_all_w48(urls: list[tuple[int, str]]) -> list[tuple[int, str, bytes | None, Exception | None]]:
    """Concurrently fetch resized (=w48) image payloads while preserving order."""

    def _download_one(item: tuple[int, str]) -> tuple[int, str, bytes | None, Exception | None]:
        idx, src = item
        resized = re.sub(r"=w\d+$", "=w48", src)
        try:
            return (idx, src, fetch_bytes(resized), None)
        except Exception as exc:
            return (idx, src, None, exc)

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
        return list(executor.map(_download_one, urls))


def fetch_year_round_moods() -> list[tuple[int, bytes, int, int]]:
    html = fetch_bytes(MOODS_URL).decode("utf-8", errors="replace")
    unique_srcs = extract_candidate_urls(html)
    print(f"Found {len(unique_srcs)} candidate mood URLs on moods page")

    download_targets: list[tuple[int, str]] = []
    for idx, src in enumerate(unique_srcs):
        token = extract_rt_token(src)
        if token and token in EXCLUDED_URL_TOKENS:
            print(f"Excluded asset #{idx:02d} by URL token")
            continue
        download_targets.append((idx, src))

    results = download_all_w48(download_targets)

    selected: list[tuple[int, bytes, int, int]] = []
    for idx, _src, raw, exc in results:
        if exc is not None or raw is None:
            print(f"Skipping candidate #{idx:02d}: {exc}")
            continue

        sha256 = hashlib.sha256(raw).hexdigest()
        if sha256 in EXCLUDED_W48_SHA256:
            print(f"Excluded asset #{idx:02d}: sha256={sha256[:12]}...")
            continue

        dims = png_dimensions(raw)
        if not dims:
            print(f"Skipping candidate #{idx:02d}: not a PNG")
            continue

        w, h = dims
        if w >= 24 and h >= 24 and 500 <= len(raw) <= 15000:
            selected.append((idx, raw, w, h))
        else:
            print(f"Skipping candidate #{idx:02d}: {w}x{h}, {len(raw)} bytes out of range")

    if len(selected) < MIN_EXPECTED_COUNT:
        raise RuntimeError(
            f"Expected at least {MIN_EXPECTED_COUNT} valid mood PNGs, got {len(selected)}"
        )
    return selected


def fetch_santa_moods() -> list[tuple[str, bytes, int, int]]:
    html = fetch_bytes(CAMPAIGN_WAZERS_URL).decode("utf-8", errors="replace")
    unique_srcs = extract_candidate_urls(html)
    print(f"Found {len(unique_srcs)} candidate URLs on campaign-specific-wazers page")

    results = download_all_w48(list(enumerate(unique_srcs)))
    matched: list[tuple[str, bytes, int, int]] = []

    for label, expected_token, expected_sha256 in SANTA_MOOD_SPECS:
        found: tuple[str, bytes, int, int] | None = None
        for idx, src, raw, exc in results:
            if exc is not None or raw is None:
                continue
            token = extract_rt_token(src)
            sha256 = hashlib.sha256(raw).hexdigest()
            if token != expected_token and sha256 != expected_sha256:
                continue
            dims = png_dimensions(raw)
            if not dims or dims[0] < 24 or dims[1] < 24:
                continue
            found = (label, raw, dims[0], dims[1])
            print(
                f"Matched seasonal mood '{label}' at campaign #{idx:02d}: "
                f"{dims[0]}x{dims[1]}, {len(raw)} bytes (sha256={sha256[:12]}...)"
            )
            break
        if found is None:
            raise RuntimeError(
                f"Failed to locate seasonal Santa mood '{label}' ({expected_sha256[:12]}...) "
                f"on {CAMPAIGN_WAZERS_URL}"
            )
        matched.append(found)

    return matched


def main() -> None:
    year_round = fetch_year_round_moods()
    santa = fetch_santa_moods()

    year_round_uris: list[str] = []
    santa_uris: list[str] = []
    total_bytes = 0

    for idx, raw, w, h in year_round:
        b64 = base64.b64encode(raw).decode("ascii")
        year_round_uris.append(f"data:image/png;base64,{b64}")
        total_bytes += len(raw)
        print(f"Selected mood #{idx:02d}: {w}x{h}, {len(raw)} bytes")

    for label, raw, w, h in santa:
        b64 = base64.b64encode(raw).decode("ascii")
        santa_uris.append(f"data:image/png;base64,{b64}")
        total_bytes += len(raw)
        print(f"Selected seasonal mood ({label}): {w}x{h}, {len(raw)} bytes")

    out_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "src", "assets")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "moods.ts")

    lines = [
        "// Auto-generated by scripts/fetch-moods.py from official Waze Moods graphic assets.",
        "// Embedded as compact 48px PNG data URIs so canvas rendering is CORS-safe and self-contained.",
        "",
        "export const YEAR_ROUND_MOOD_URIS: readonly string[] = [",
    ]
    for uri in year_round_uris:
        lines.append(f'    "{uri}",')
    lines.extend(
        [
            "];",
            "",
            "// Seasonal Santa moods (Happy Santa, Not happy Santa): Nov 28 - Jan 6 inclusive",
            "export const SANTA_MOOD_URIS: readonly string[] = [",
        ]
    )
    for uri in santa_uris:
        lines.append(f'    "{uri}",')
    lines.extend(
        [
            "];",
            "",
            "export const YEAR_ROUND_MOOD_COUNT = YEAR_ROUND_MOOD_URIS.length;",
            "export const SANTA_MOOD_COUNT = SANTA_MOOD_URIS.length;",
            "export const WAZER_MOOD_URIS: readonly string[] = [...YEAR_ROUND_MOOD_URIS, ...SANTA_MOOD_URIS];",
            "",
            "export function preloadMoodSprites(): HTMLImageElement[] {",
            '    if (typeof Image === "undefined") return [];',
            "    return WAZER_MOOD_URIS.map((uri) => {",
            "        const img = new Image();",
            '        img.decoding = "async";',
            "        img.src = uri;",
            "        return img;",
            "    });",
            "}",
            "",
        ]
    )

    with open(out_path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines))

    print(
        f"Wrote {out_path} ({len(year_round_uris)} year-round + {len(santa_uris)} Santa = "
        f"{len(year_round_uris) + len(santa_uris)} icons, {total_bytes} raw PNG bytes)"
    )


if __name__ == "__main__":
    main()
