#!/usr/bin/env python3

import argparse
import gzip
import hashlib
import html
import json
import os
import re
import shutil
import stat
import tarfile
import urllib.parse
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
COINBASE_SKILL_PRODUCTS = ("coinbase-cli", "coinbase-mcp")
EXPECTED_MCP_URL = "https://agents.coinbase.com/mcp"
EXPECTED_CHATGPT_MCP_URL = "https://agents.coinbase.com/mcp/chatgpt"
OUTPUT_MARKER = ".coinbase-agents-distributions"
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
    shutil.copytree(source, target)


def copy_skills(
    target: Path, products: tuple[str, ...] = COINBASE_SKILL_PRODUCTS
) -> None:
    source_root = ROOT / "skills"
    if source_root.is_symlink() or not products:
        raise ValueError(
            "skills require a regular source directory and selected products"
        )
    router = source_root / "coinbase"
    if router.is_symlink() or not (router / "SKILL.md").is_file():
        raise ValueError(f"invalid shared router skill: {router}")
    selected = {"coinbase": router}
    for product in products:
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", product):
            raise ValueError(f"invalid skill product: {product}")
        source = source_root / product
        if source.is_symlink() or not source.is_dir():
            raise ValueError(f"invalid skill product directory: {source}")
        entries = sorted(source.iterdir())
        if not entries:
            raise ValueError(f"no skills in product: {source}")
        for skill in entries:
            if (
                skill.is_symlink()
                or not skill.is_dir()
                or not (skill / "SKILL.md").is_file()
            ):
                raise ValueError(f"invalid skill entry: {skill}")
            if skill.name in selected:
                raise ValueError(
                    f"duplicate skill across selected products: {skill.name}"
                )
            selected[skill.name] = skill
    target.mkdir(parents=True)
    destinations = {
        source.resolve(): target / name for name, source in selected.items()
    }
    for source, destination in destinations.items():
        copy_tree(source, destination)
    for source, destination in destinations.items():
        rebase_skill_links(source, destination, destinations)


def rebase_skill_links(
    source: Path, target: Path, destinations: dict[Path, Path]
) -> None:
    for document in source.rglob("*.md"):
        output = target / document.relative_to(source)

        def rebase(match: re.Match) -> str:
            raw = match.group(1)
            path, separator, fragment = raw.partition("#")
            if not path or "://" in path or path.startswith("mailto:"):
                return match.group(0)
            resolved = (document.parent / path).resolve()
            for original, destination in destinations.items():
                if resolved.is_relative_to(original):
                    mapped = destination / resolved.relative_to(original)
                    relative = Path(os.path.relpath(mapped, output.parent)).as_posix()
                    return f"]({relative}{separator}{fragment})"
            raise ValueError(f"link outside selected skills: {document} -> {raw}")

        output.write_text(re.sub(r"\]\(([^)]+)\)", rebase, document.read_text()))


def copy_common(target: Path) -> None:
    copy_file(ROOT / "LICENSE", target / "LICENSE")
    copy_file(ROOT / "src/plugins/README.md", target / "README.md")


def build_portable(target: Path, manifest_dir: str = "portable") -> None:
    target.mkdir(parents=True)
    copy_file(ROOT / f"src/plugins/{manifest_dir}/plugin.json", target / "plugin.json")
    copy_file(ROOT / f"src/plugins/{manifest_dir}/mcp.json", target / "mcp.json")
    copy_skills(target / "skills")
    asset_dir = target / "com.openai/assets"
    asset_dir.mkdir(parents=True)
    copy_file(ROOT / "assets/coinbase.svg", asset_dir / "coinbase.svg")
    copy_common(target)


def build_chatgpt(target: Path) -> None:
    build_portable(target, "chatgpt")
    icon_path = target / "com.openai/assets/coinbase.svg"
    ET.register_namespace("", "http://www.w3.org/2000/svg")
    icon = ET.parse(
        icon_path, parser=ET.XMLParser(target=ET.TreeBuilder(insert_comments=True))
    )
    icon.getroot().set("width", "64")
    icon.getroot().set("height", "64")
    icon.write(icon_path, encoding="unicode")


def build_claude(target: Path) -> None:
    manifest_dir = target / ".claude-plugin"
    manifest_dir.mkdir(parents=True)
    copy_file(ROOT / "src/plugins/claude/plugin.json", manifest_dir / "plugin.json")
    copy_file(
        ROOT / "src/plugins/claude/marketplace.json",
        manifest_dir / "marketplace.json",
    )
    copy_skills(target / "skills")
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


def validate_skills(root: Path) -> None:
    skills = root / "skills"
    entries = sorted(skills.iterdir())
    if not entries:
        raise ValueError(f"no skills in distribution: {skills}")
    for skill in entries:
        skill_file = skill / "SKILL.md"
        if not skill.is_dir() or not skill_file.is_file():
            raise ValueError(f"invalid skill entry: {skill}")
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


def validate_portable(
    root: Path, version: str, expected_mcp_url: str = EXPECTED_MCP_URL
) -> None:
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
    if server != {"type": "streamable-http", "url": expected_mcp_url}:
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


def validate_chatgpt(root: Path, version: str) -> None:
    validate_portable(root, version, expected_mcp_url=EXPECTED_CHATGPT_MCP_URL)
    interface = load_json(root / "plugin.json")["extensions"]["com.openai"]["interface"]
    if not 1 <= len(interface.get("shortDescription", "")) <= 30:
        raise ValueError("ChatGPT shortDescription must be 1–30 characters")
    for field in ("websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"):
        value = interface.get(field, "")
        url = urllib.parse.urlsplit(value)
        if (
            not 1 <= len(value) <= 1024
            or url.scheme != "https"
            or not url.hostname
            or url.username is not None
            or url.password is not None
        ):
            raise ValueError(f"invalid ChatGPT {field}")
    for field in ("logo", "composerIcon"):
        icon = ET.parse(root / interface[field]).getroot()
        if icon.get("width") != "64" or icon.get("height") != "64":
            raise ValueError(f"ChatGPT {field} must declare 64×64 dimensions")


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
                (stat.S_IFDIR | 0o755) if path.is_dir() else (stat.S_IFREG | 0o644)
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
                        info.mode = 0o644
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
    args = parser.parse_args()

    manifest = load_json(ROOT / "src/plugins/portable/plugin.json")
    version = manifest.get("version", "")
    if not SEMVER.fullmatch(version):
        raise ValueError(f"invalid semantic version: {version}")

    claude = load_json(ROOT / "src/plugins/claude/plugin.json")
    marketplace = load_json(ROOT / "src/plugins/claude/marketplace.json")
    marketplace_plugin = get_single_plugin(marketplace, "Claude")
    if claude.get("version") != version or marketplace_plugin.get("version") != version:
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

    portable = packages / f"coinbase-agent-plugin-v{version}"
    claude_target = packages / f"coinbase-claude-v{version}"
    codex_target = packages / f"coinbase-codex-v{version}"
    chatgpt_target = packages / f"coinbase-chatgpt-v{version}"
    build_portable(portable)
    build_claude(claude_target)
    build_codex(codex_target, portable)
    build_chatgpt(chatgpt_target)
    validate_portable(portable, version)
    validate_claude(claude_target, version)
    validate_codex(codex_target, version)
    validate_chatgpt(chatgpt_target, version)

    archives = []
    for package in (portable, claude_target, codex_target, chatgpt_target):
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
