import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "build_distributions", ROOT / "scripts/build-distributions.py"
)
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


class DistributionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.chatgpt = self.root / "chatgpt"
        builder.build_chatgpt(self.chatgpt)
        self.version = builder.load_json(self.chatgpt / "plugin.json")["version"]

    def update_interface(self, field, value):
        path = self.chatgpt / "plugin.json"
        manifest = builder.load_json(path)
        interface = manifest["extensions"]["com.openai"]["interface"]
        if value is None:
            interface.pop(field, None)
        else:
            interface[field] = value
        path.write_text(json.dumps(manifest))

    def test_chatgpt_listing_urls(self):
        builder.validate_chatgpt(self.chatgpt, self.version)
        manifest = builder.load_json(self.chatgpt / "plugin.json")
        interface = manifest["extensions"]["com.openai"]["interface"]
        expected = {
            "websiteURL": "https://www.coinbase.com",
            "supportURL": "https://help.coinbase.com/en",
            "privacyPolicyURL": "https://www.coinbase.com/legal/privacy",
            "termsOfServiceURL": (
                "https://www.coinbase.com/legal/user_agreement/united_states"
            ),
        }
        for field, value in expected.items():
            self.assertEqual(interface[field], value)

    def test_chatgpt_listing_describes_only_remote_mcp(self):
        manifest = builder.load_json(self.chatgpt / "plugin.json")
        interface = manifest["extensions"]["com.openai"]["interface"]
        for text in (
            manifest["description"],
            interface["shortDescription"],
            interface["longDescription"],
            *manifest["keywords"],
        ):
            self.assertNotRegex(text.lower(), r"\b(cli|local|shell)\b")
        self.assertIn("remote MCP", manifest["description"])
        self.assertIn("remote MCP", interface["longDescription"])
        self.assertIn("OAuth", interface["longDescription"])

    def test_existing_distributions_keep_portable_metadata_and_icon(self):
        portable = self.root / "portable"
        codex = self.root / "codex"
        builder.build_portable(portable)
        builder.build_codex(codex, portable)
        for package in (portable, codex / "plugins/coinbase"):
            self.assertEqual(
                (package / "plugin.json").read_bytes(),
                (ROOT / "src/plugins/portable/plugin.json").read_bytes(),
            )
            self.assertEqual(
                (package / "com.openai/assets/coinbase.svg").read_bytes(),
                (ROOT / "assets/coinbase.svg").read_bytes(),
            )
            interface = builder.load_json(package / "plugin.json")["extensions"][
                "com.openai"
            ]["interface"]
            self.assertNotIn("supportURL", interface)
            self.assertNotIn("privacyPolicyURL", interface)
            self.assertNotIn("termsOfServiceURL", interface)

    def test_chatgpt_reuses_canonical_mcp_and_skills(self):
        self.assertEqual(
            (self.chatgpt / "mcp.json").read_bytes(),
            (ROOT / "src/plugins/portable/mcp.json").read_bytes(),
        )
        expected = {
            path.relative_to(ROOT / "skills"): path.read_bytes()
            for path in (ROOT / "skills").rglob("*")
            if path.is_file()
        }
        actual = {
            path.relative_to(self.chatgpt / "skills"): path.read_bytes()
            for path in (self.chatgpt / "skills").rglob("*")
            if path.is_file()
        }
        self.assertEqual(actual, expected)

    def test_chatgpt_icon_preserves_artwork_at_larger_dimensions(self):
        source = ET.parse(ROOT / "assets/coinbase.svg").getroot()
        icon = ET.parse(self.chatgpt / "com.openai/assets/coinbase.svg").getroot()
        self.assertEqual((icon.get("width"), icon.get("height")), ("64", "64"))
        self.assertEqual(icon.get("viewBox"), source.get("viewBox"))
        self.assertEqual(
            [element.attrib for element in icon],
            [element.attrib for element in source],
        )
        self.assertIn(
            "https://mintcdn.com/coinbase-prod/",
            (self.chatgpt / "com.openai/assets/coinbase.svg").read_text(),
        )

    def test_chatgpt_rejects_invalid_subtitle_lengths(self):
        for value in ("", "x" * 31):
            with self.subTest(value=value):
                self.update_interface("shortDescription", value)
                with self.assertRaisesRegex(ValueError, "shortDescription"):
                    builder.validate_chatgpt(self.chatgpt, self.version)

    def test_chatgpt_requires_public_https_listing_urls(self):
        for field in (
            "websiteURL",
            "supportURL",
            "privacyPolicyURL",
            "termsOfServiceURL",
        ):
            for value in (None, "http://example.com", "https://user:pass@example.com"):
                with self.subTest(field=field, value=value):
                    self.update_interface(field, value)
                    with self.assertRaisesRegex(ValueError, field):
                        builder.validate_chatgpt(self.chatgpt, self.version)
                    self.update_interface(field, "https://example.com")

    def test_chatgpt_rejects_incorrect_icon_dimensions(self):
        path = self.chatgpt / "com.openai/assets/coinbase.svg"
        icon = ET.parse(path)
        icon.getroot().set("width", "32")
        icon.write(path, encoding="unicode")
        with self.assertRaisesRegex(ValueError, "dimensions"):
            builder.validate_chatgpt(self.chatgpt, self.version)

    def test_chatgpt_requires_matching_version(self):
        with self.assertRaisesRegex(ValueError, "identity"):
            builder.validate_chatgpt(self.chatgpt, "99.0.0")

    def test_full_build_lists_and_checksums_all_four_distributions(self):
        output = self.root / "dist"
        subprocess.run(
            [sys.executable, str(ROOT / "scripts/build-distributions.py"), str(output)],
            check=True,
        )
        site = output / "site"
        latest = builder.load_json(site / "latest.json")
        self.assertEqual(len(latest["downloads"]), 8)
        for line in (site / "downloads/SHA256SUMS").read_text().splitlines():
            digest, filename = line.split("  ")
            self.assertEqual(
                hashlib.sha256(
                    (site / "downloads" / filename).read_bytes()
                ).hexdigest(),
                digest,
            )
        name = f"coinbase-chatgpt-v{self.version}"
        self.assertIn(f"downloads/{name}.zip", latest["downloads"])
        self.assertIn(f"downloads/{name}.tar.gz", latest["downloads"])
        self.assertIn(f"{name}.zip", (site / "index.html").read_text())
        with zipfile.ZipFile(site / "downloads" / f"{name}.zip") as archive:
            self.assertIn(f"{name}/plugin.json", archive.namelist())
            self.assertIn(f"{name}/mcp.json", archive.namelist())
            self.assertIn(f"{name}/skills/coinbase/SKILL.md", archive.namelist())


if __name__ == "__main__":
    unittest.main()
