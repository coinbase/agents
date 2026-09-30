#!/usr/bin/env python3

import argparse
import hashlib
import html
import json
import re
import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXPECTED_MCP_URL = "https://agents.coinbase.com/mcp"
SEMVER = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
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


def copy_tree(source: Path, target: Path) -> None:
    for path in source.rglob("*"):
        if path.is_symlink():
            raise ValueError(f"symlink is not allowed in a distribution: {path}")
    shutil.copytree(source, target)


def copy_common(target: Path) -> None:
    shutil.copy2(ROOT / "LICENSE", target / "LICENSE")
    shutil.copy2(ROOT / "src/plugins/README.md", target / "README.md")


def build_portable(target: Path) -> None:
    target.mkdir(parents=True)
    shutil.copy2(ROOT / "src/plugins/portable/plugin.json", target / "plugin.json")
    shutil.copy2(ROOT / "src/plugins/portable/mcp.json", target / "mcp.json")
    copy_tree(ROOT / "skills", target / "skills")
    asset_dir = target / "com.openai/assets"
    asset_dir.mkdir(parents=True)
    shutil.copy2(ROOT / "assets/coinbase.svg", asset_dir / "coinbase.svg")
    copy_common(target)


def build_claude(target: Path) -> None:
    manifest_dir = target / ".claude-plugin"
    manifest_dir.mkdir(parents=True)
    shutil.copy2(ROOT / "src/plugins/claude/plugin.json", manifest_dir / "plugin.json")
    shutil.copy2(
        ROOT / "src/plugins/claude/marketplace.json",
        manifest_dir / "marketplace.json",
    )
    copy_tree(ROOT / "skills", target / "skills")
    copy_common(target)


def build_codex(target: Path, portable: Path) -> None:
    catalog_dir = target / ".agents/plugins"
    catalog_dir.mkdir(parents=True)
    shutil.copy2(
        ROOT / "src/plugins/codex/marketplace.json",
        catalog_dir / "marketplace.json",
    )
    shutil.copytree(portable, target / "plugins/coinbase")
    copy_common(target)


def validate_skills(root: Path) -> None:
    skills = root / "skills"
    entries = sorted(skills.iterdir())
    if len(entries) != 9:
        raise ValueError(f"expected 9 skills, found {len(entries)}")
    for skill in entries:
        skill_file = skill / "SKILL.md"
        if not skill.is_dir() or not skill_file.is_file():
            raise ValueError(f"invalid skill entry: {skill}")
        for reference in ("cli.md", "mcp.md"):
            if not (skill / "references" / reference).is_file():
                raise ValueError(
                    f"missing reference: {skill / 'references' / reference}"
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
        if name != skill.name or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name):
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
        if not asset.startswith("./") or not (root / asset[2:]).is_file():
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
    plugin = marketplace.get("plugins", [{}])[0]
    if plugin.get("source") != "./" or plugin.get("version") != version:
        raise ValueError("invalid Claude marketplace entry")
    validate_skills(root)
    validate_links(root)


def validate_codex(root: Path, version: str) -> None:
    marketplace = load_json(root / ".agents/plugins/marketplace.json")
    plugin = marketplace.get("plugins", [{}])[0]
    expected = {"source": "local", "path": "./plugins/coinbase"}
    if plugin.get("name") != "coinbase" or plugin.get("source") != expected:
        raise ValueError("invalid Codex marketplace entry")
    validate_portable(root / "plugins/coinbase", version)


def archive(package_dir: Path, downloads: Path) -> list[Path]:
    base = downloads / package_dir.name
    zip_path = Path(
        shutil.make_archive(
            str(base),
            "zip",
            root_dir=package_dir.parent,
            base_dir=package_dir.name,
        )
    )
    tar_path = Path(
        shutil.make_archive(
            str(base),
            "gztar",
            root_dir=package_dir.parent,
            base_dir=package_dir.name,
        )
    )
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
    args = parser.parse_args()

    manifest = load_json(ROOT / "src/plugins/portable/plugin.json")
    version = manifest.get("version", "")
    if not SEMVER.fullmatch(version):
        raise ValueError(f"invalid semantic version: {version}")

    claude = load_json(ROOT / "src/plugins/claude/plugin.json")
    marketplace = load_json(ROOT / "src/plugins/claude/marketplace.json")
    if (
        claude.get("version") != version
        or marketplace.get("plugins", [{}])[0].get("version") != version
    ):
        raise ValueError("distribution versions do not match")

    output = args.output.resolve()
    if output == ROOT or output in ROOT.parents:
        raise ValueError("output cannot contain the repository")
    if output.exists():
        shutil.rmtree(output)
    packages = output / "site/packages"
    downloads = output / "site/downloads"
    packages.mkdir(parents=True)
    downloads.mkdir(parents=True)

    portable = packages / f"coinbase-agent-plugin-v{version}"
    claude_target = packages / f"coinbase-claude-v{version}"
    codex_target = packages / f"coinbase-codex-v{version}"
    build_portable(portable)
    build_claude(claude_target)
    build_codex(codex_target, portable)
    validate_portable(portable, version)
    validate_claude(claude_target, version)
    validate_codex(codex_target, version)

    archives = []
    for package in (portable, claude_target, codex_target):
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
