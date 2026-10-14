#!/usr/bin/env python3

import argparse
import gzip
import hashlib
import html
import json
import re
import shutil
import stat
import tarfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXPECTED_MCP_URL = "https://agents.coinbase.com/mcp"
OUTPUT_MARKER = ".coinbase-agents-distributions"
SKILL_COUNT = 10
PAPER_SKILL = "coinbase-paper-trading"
PAPER_FILES = (
    "SKILL.md",
    "START-HERE.md",
    "references/cli.md",
    "references/mcp.md",
    "references/host-setup.md",
    "references/connector-instructions.md",
    "references/qa.md",
    "scripts/paper.py",
    "scripts/paper_cli.py",
    "scripts/public_data.py",
    "bin/coinbase-paper",
)
REQUIRED_SKILL_FILES = {PAPER_SKILL: PAPER_FILES}
EXECUTABLE_SKILL_FILES = {PAPER_SKILL: ("bin/coinbase-paper",)}
EXCLUDED_PATTERNS = ("__pycache__", "*.pyc", "*.pyo", ".DS_Store")
FORBIDDEN_SUFFIXES = (".pyc", ".pyo", ".db", ".sqlite", ".sqlite3", "-journal", "-wal")
PRERELEASE_IDENTIFIER = r"(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)"
SEMVER = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    rf"(?:-{PRERELEASE_IDENTIFIER}(?:\.{PRERELEASE_IDENTIFIER})*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)
PORTABLE_FIELDS = {
    "$schema",
    "name",
    "version",
    "description",
    "author",
    "homepage",
    "repository",
    "license",
    "keywords",
    "extensions",
}


def load_json(path: Path) -> dict:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def get_single_plugin(marketplace: dict, label: str) -> dict:
    plugins = marketplace.get("plugins")
    if (
        not isinstance(plugins, list)
        or len(plugins) != 1
        or not isinstance(plugins[0], dict)
    ):
        raise ValueError(f"{label} marketplace must contain exactly one plugin")
    return plugins[0]


def copy_file(source: Path, target: Path) -> None:
    if source.is_symlink() or not source.is_file():
        raise ValueError(f"distribution source must be a regular file: {source}")
    resolved = source.resolve()
    if ROOT not in (resolved, *resolved.parents):
        raise ValueError(f"distribution source escapes the repository: {source}")
    shutil.copy2(source, target)


def copy_tree(source: Path, target: Path) -> None:
    if source.is_symlink() or not source.is_dir():
        raise ValueError(f"distribution source must be a directory: {source}")
    for path in source.rglob("*"):
        if path.is_symlink():
            raise ValueError(f"symlink is not allowed in a distribution: {path}")
    shutil.copytree(source, target, ignore=shutil.ignore_patterns(*EXCLUDED_PATTERNS))


def copy_common(target: Path) -> None:
    copy_file(ROOT / "LICENSE", target / "LICENSE")
    copy_file(ROOT / "src/plugins/README.md", target / "README.md")


def build_portable(target: Path) -> None:
    target.mkdir(parents=True)
    copy_file(ROOT / "src/plugins/portable/plugin.json", target / "plugin.json")
    copy_file(ROOT / "src/plugins/portable/mcp.json", target / "mcp.json")
    copy_tree(ROOT / "skills", target / "skills")
    asset_dir = target / "com.openai/assets"
    asset_dir.mkdir(parents=True)
    copy_file(ROOT / "assets/coinbase.svg", asset_dir / "coinbase.svg")
    copy_common(target)


def build_claude(target: Path) -> None:
    manifest_dir = target / ".claude-plugin"
    manifest_dir.mkdir(parents=True)
    copy_file(ROOT / "src/plugins/claude/plugin.json", manifest_dir / "plugin.json")
    copy_file(
        ROOT / "src/plugins/claude/marketplace.json",
        manifest_dir / "marketplace.json",
    )
    copy_tree(ROOT / "skills", target / "skills")
    copy_common(target)


def build_codex(target: Path, portable: Path) -> None:
    catalog_dir = target / ".agents/plugins"
    catalog_dir.mkdir(parents=True)
    copy_file(
        ROOT / "src/plugins/codex/marketplace.json",
        catalog_dir / "marketplace.json",
    )
    shutil.copytree(portable, target / "plugins/coinbase")
    copy_common(target)


def validate_skills(root: Path, standalone: bool = False) -> None:
    skills = root if standalone else root / "skills"
    entries = [root] if standalone else sorted(skills.iterdir())
    expected = 1 if standalone else SKILL_COUNT
    if len(entries) != expected:
        raise ValueError(f"expected {expected} skills, found {len(entries)}")
    for path in skills.rglob("*"):
        if path.name == "__pycache__" or path.name.endswith(FORBIDDEN_SUFFIXES):
            raise ValueError(f"cache or state file in distribution: {path}")
    for skill in entries:
        skill_name = PAPER_SKILL if standalone else skill.name
        skill_file = skill / "SKILL.md"
        if not skill.is_dir() or not skill_file.is_file():
            raise ValueError(f"invalid skill entry: {skill}")
        for reference in ("cli.md", "mcp.md"):
            if not (skill / "references" / reference).is_file():
                raise ValueError(
                    f"missing reference: {skill / 'references' / reference}"
                )
        for required in REQUIRED_SKILL_FILES.get(skill_name, ()):
            if not (skill / required).is_file():
                raise ValueError(f"missing skill file: {skill / required}")
        if skill_name == PAPER_SKILL:
            # Allowlist: no account state, saved requests, profiles, or extras.
            found = {
                path.relative_to(skill).as_posix()
                for path in skill.rglob("*")
                if not path.is_dir()
            }
            if standalone:
                found -= {"LICENSE"}
            if found != set(PAPER_FILES):
                raise ValueError(f"unexpected paper skill contents: {skill}")
        for executable in EXECUTABLE_SKILL_FILES.get(skill_name, ()):
            if not (skill / executable).stat().st_mode & 0o100:
                raise ValueError(
                    f"skill launcher is not executable: {skill / executable}"
                )
        text = skill_file.read_text()
        match = re.match(r"^---\n(.*?)\n---\n", text, re.DOTALL)
        if not match:
            raise ValueError(f"invalid frontmatter: {skill_file}")
        fields = dict(
            line.split(":", 1) for line in match.group(1).splitlines() if ":" in line
        )
        name = fields.get("name", "").strip()
        description = fields.get("description", "").strip()
        if name != skill_name or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name):
            raise ValueError(f"invalid skill name: {skill_file}")
        if not 1 <= len(description) <= 1024:
            raise ValueError(f"invalid skill description: {skill_file}")


def validate_links(root: Path) -> None:
    for document in root.rglob("*.md"):
        for raw_target in re.findall(r"\]\(([^)]+)\)", document.read_text()):
            target = raw_target.split("#", 1)[0]
            if not target or "://" in target or target.startswith("mailto:"):
                continue
            resolved = (document.parent / target).resolve()
            if root.resolve() not in (resolved, *resolved.parents):
                raise ValueError(f"link escapes distribution: {document} -> {target}")
            if not resolved.exists():
                raise ValueError(f"broken link: {document} -> {target}")


def paper_version() -> str:
    text = (ROOT / "skills" / PAPER_SKILL / "SKILL.md").read_text()
    match = re.search(r"^  version: (\S+)$", text, re.MULTILINE)
    if not match or not SEMVER.fullmatch(match.group(1)):
        raise ValueError("invalid paper skill version")
    return match.group(1)


def build_paper_bundle(target: Path) -> None:
    target.mkdir(parents=True)
    for relative in PAPER_FILES:
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        copy_file(ROOT / "skills" / PAPER_SKILL / relative, destination)
    copy_file(ROOT / "LICENSE", target / "LICENSE")
    validate_skills(target, standalone=True)
    validate_links(target)
    checksums = [
        f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.relative_to(target).as_posix()}"
        for path in sorted(target.rglob("*"))
        if path.is_file()
    ]
    (target / "SHA256SUMS").write_text("\n".join(checksums) + "\n")


def validate_portable(root: Path, version: str) -> None:
    manifest = load_json(root / "plugin.json")
    mcp = load_json(root / "mcp.json")
    unknown = set(manifest) - PORTABLE_FIELDS
    if unknown:
        raise ValueError(f"unknown portable manifest fields: {sorted(unknown)}")
    if (
        manifest.get("$schema")
        != "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
    ):
        raise ValueError("invalid plugin schema")
    if manifest.get("name") != "coinbase" or manifest.get("version") != version:
        raise ValueError("invalid plugin identity")
    if not re.fullmatch(r"[a-z0-9]+(?:[.-][a-z0-9]+)*", manifest["name"]):
        raise ValueError("invalid plugin name")
    if set(mcp) != {"$schema", "mcpServers"}:
        raise ValueError("invalid MCP top-level fields")
    if mcp.get("$schema") != "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json":
        raise ValueError("invalid MCP schema")
    server = mcp.get("mcpServers", {}).get("coinbase", {})
    if set(server) != {"type", "url"} or set(mcp["mcpServers"]) != {"coinbase"}:
        raise ValueError("invalid MCP server fields")
    if server != {"type": "streamable-http", "url": EXPECTED_MCP_URL}:
        raise ValueError("invalid portable MCP server")
    for namespace, value in manifest.get("extensions", {}).items():
        if not re.fullmatch(r"(?:[a-z0-9-]+\.)+[a-z0-9-]+", namespace):
            raise ValueError(f"invalid extension namespace: {namespace}")
        if not isinstance(value, dict):
            raise ValueError(f"invalid extension value: {namespace}")
    interface = manifest["extensions"]["com.openai"]["interface"]
    for field in ("logo", "composerIcon"):
        asset = interface[field]
        asset_path = root / asset[2:] if isinstance(asset, str) else root
        resolved = asset_path.resolve()
        if (
            not isinstance(asset, str)
            or not asset.startswith("./")
            or root.resolve() not in (resolved, *resolved.parents)
            or not asset_path.is_file()
        ):
            raise ValueError(f"invalid OpenAI {field} path")
    validate_skills(root)
    validate_links(root)


def validate_claude(root: Path, version: str) -> None:
    manifest = load_json(root / ".claude-plugin/plugin.json")
    marketplace = load_json(root / ".claude-plugin/marketplace.json")
    server = manifest.get("mcpServers", {}).get("coinbase", {})
    if manifest.get("name") != "coinbase" or manifest.get("version") != version:
        raise ValueError("invalid Claude plugin identity")
    if manifest.get("skills") != "./skills/":
        raise ValueError("invalid Claude skills path")
    if server != {"type": "http", "url": EXPECTED_MCP_URL}:
        raise ValueError("invalid Claude MCP server")
    plugin = get_single_plugin(marketplace, "Claude")
    if (
        marketplace.get("name") != "coinbase-agents"
        or plugin.get("name") != "coinbase"
        or plugin.get("source") != "./"
        or plugin.get("version") != version
    ):
        raise ValueError("invalid Claude marketplace entry")
    validate_skills(root)
    validate_links(root)


def validate_codex(root: Path, version: str) -> None:
    marketplace = load_json(root / ".agents/plugins/marketplace.json")
    plugin = get_single_plugin(marketplace, "Codex")
    expected = {"source": "local", "path": "./plugins/coinbase"}
    if plugin.get("name") != "coinbase" or plugin.get("source") != expected:
        raise ValueError("invalid Codex marketplace entry")
    validate_portable(root / "plugins/coinbase", version)


def mode(path: Path) -> int:
    return 0o755 if path.stat().st_mode & 0o111 else 0o644


def archive(package_dir: Path, downloads: Path) -> list[Path]:
    base = downloads / package_dir.name
    paths = [package_dir, *sorted(package_dir.rglob("*"))]
    zip_path = Path(f"{base}.zip")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive_file:
        for path in paths:
            name = path.relative_to(package_dir.parent).as_posix()
            info = zipfile.ZipInfo(
                f"{name}/" if path.is_dir() else name,
                date_time=(1980, 1, 1, 0, 0, 0),
            )
            info.create_system = 3
            info.external_attr = (
                (stat.S_IFDIR | 0o755) if path.is_dir() else (stat.S_IFREG | mode(path))
            ) << 16
            archive_file.writestr(
                info,
                b"" if path.is_dir() else path.read_bytes(),
                compress_type=zipfile.ZIP_DEFLATED,
            )

    tar_path = Path(f"{base}.tar.gz")
    with tar_path.open("wb") as raw_file:
        with gzip.GzipFile(
            filename="", mode="wb", fileobj=raw_file, mtime=0
        ) as gzip_file:
            with tarfile.open(fileobj=gzip_file, mode="w") as archive_file:
                for path in paths:
                    info = tarfile.TarInfo(
                        path.relative_to(package_dir.parent).as_posix()
                    )
                    info.mtime = 0
                    info.uid = info.gid = 0
                    info.uname = info.gname = ""
                    if path.is_dir():
                        info.type = tarfile.DIRTYPE
                        info.mode = 0o755
                        archive_file.addfile(info)
                    else:
                        info.mode = mode(path)
                        info.size = path.stat().st_size
                        with path.open("rb") as source:
                            archive_file.addfile(info, source)
    return [zip_path, tar_path]


def write_index(site: Path, version: str, archives: list[Path]) -> None:
    links = "\n".join(
        f'<li><a href="downloads/{html.escape(path.name)}">{html.escape(path.name)}</a></li>'
        for path in archives
    )
    (site / "index.html").write_text(
        '<!doctype html><meta charset="utf-8">'
        "<title>Coinbase agent plugins</title>"
        "<main><h1>Coinbase agent plugins</h1>"
        f"<p>Version {html.escape(version)}</p><ul>{links}"
        '<li><a href="downloads/SHA256SUMS">SHA256SUMS</a></li></ul></main>\n'
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument(
        "--paper-only",
        action="store_true",
        help="build only the host-neutral paper-trading skill bundle, without live skills",
    )
    args = parser.parse_args()

    if args.paper_only:
        version = paper_version()
    else:
        manifest = load_json(ROOT / "src/plugins/portable/plugin.json")
        version = manifest.get("version", "")
        if not SEMVER.fullmatch(version):
            raise ValueError(f"invalid semantic version: {version}")
        claude = load_json(ROOT / "src/plugins/claude/plugin.json")
        marketplace = load_json(ROOT / "src/plugins/claude/marketplace.json")
        marketplace_plugin = get_single_plugin(marketplace, "Claude")
        if (
            claude.get("version") != version
            or marketplace_plugin.get("version") != version
        ):
            raise ValueError("distribution versions do not match")

    if args.output.is_symlink():
        raise ValueError("output cannot be a symlink")
    output = args.output.resolve()
    if output == ROOT or output in ROOT.parents:
        raise ValueError("output cannot contain the repository")
    for source in (ROOT / "assets", ROOT / "skills", ROOT / "src"):
        if output == source or source in output.parents:
            raise ValueError("output cannot be inside a distribution source directory")
    if output.exists():
        marker = output / OUTPUT_MARKER
        if not output.is_dir() or (any(output.iterdir()) and not marker.is_file()):
            raise ValueError("refusing to replace an unrecognized output directory")
        shutil.rmtree(output)
    output.mkdir(parents=True)
    (output / OUTPUT_MARKER).touch()
    packages = output / "site/packages"
    downloads = output / "site/downloads"
    packages.mkdir(parents=True)
    downloads.mkdir(parents=True)

    if args.paper_only:
        paper_target = packages / f"{PAPER_SKILL}-v{version}"
        build_paper_bundle(paper_target)
        package_dirs = (paper_target,)
    else:
        portable = packages / f"coinbase-agent-plugin-v{version}"
        claude_target = packages / f"coinbase-claude-v{version}"
        codex_target = packages / f"coinbase-codex-v{version}"
        build_portable(portable)
        build_claude(claude_target)
        build_codex(codex_target, portable)
        validate_portable(portable, version)
        validate_claude(claude_target, version)
        validate_codex(codex_target, version)
        package_dirs = (portable, claude_target, codex_target)

    archives = []
    for package in package_dirs:
        archives.extend(archive(package, downloads))
    checksums = [
        f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}"
        for path in archives
    ]
    (downloads / "SHA256SUMS").write_text("\n".join(checksums) + "\n")
    (output / "site/latest.json").write_text(
        json.dumps(
            {
                "version": version,
                "downloads": [f"downloads/{path.name}" for path in archives],
            },
            indent=2,
        )
        + "\n"
    )
    write_index(output / "site", version, archives)


if __name__ == "__main__":
    main()
