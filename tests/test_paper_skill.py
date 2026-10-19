import os
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "skills/coinbase-paper"


class PaperSkillTests(unittest.TestCase):
    def test_layout_and_links(self):
        self.assertEqual(
            {path.name for path in SKILL.iterdir()},
            {"SKILL.md", "references", "scripts"},
        )
        entry = (SKILL / "SKILL.md").read_text()
        self.assertTrue(entry.startswith("---\nname: coinbase-paper\n"))
        self.assertIn("](references/commands.md)", entry)
        self.assertIn("](../coinbase/SKILL.md)", entry)
        commands = (SKILL / "references/commands.md").read_text()
        self.assertFalse(commands.startswith("---\n"))
        self.assertIn("](../SKILL.md)", commands)

    def test_launcher_runs_the_bundled_typescript_without_dependencies(self):
        launcher = SKILL / "scripts/coinbase-paper"
        self.assertTrue(os.access(launcher, os.X_OK))
        self.assertIn(
            'node --experimental-strip-types --no-warnings "$dir/src/cli.ts"',
            launcher.read_text(),
        )
        self.assertEqual(
            (SKILL / "scripts/package.json").read_text(),
            '{\n  "private": true,\n  "type": "module"\n}\n',
        )
        for source in (SKILL / "scripts/src").rglob("*.ts"):
            for specifier in re.findall(
                r"""(?:from|import\()\s*['"]([^'"]+)['"]""", source.read_text()
            ):
                with self.subTest(source=source.name, specifier=specifier):
                    self.assertTrue(
                        specifier.startswith(("node:", "./", "../")),
                        "the simulator must only use Node built-ins and its own files",
                    )

    def test_simulator_never_reaches_authenticated_or_live_paths(self):
        for source in (SKILL / "scripts/src").rglob("*.ts"):
            if source.name.endswith(".test.ts"):
                continue
            text = source.read_text()
            with self.subTest(source=source.name):
                self.assertNotIn("COINBASE_KEY", text)
                self.assertNotIn("api/v3/brokerage/orders", text)
                self.assertNotIn("lock-live", text)
                for host in re.findall(r"https://([a-z0-9.-]+)", text):
                    self.assertIn(
                        host,
                        {"api.coinbase.com", "example.com", "www.nasdaq.com"},
                    )

    def test_skill_keeps_paper_safety_rules(self):
        entry = (SKILL / "SKILL.md").read_text()
        for marker in (
            "Every result is **PAPER**",
            "Never keep a ledger in the conversation",
            "Switching needs the user's explicit words",
            "A resting paper order is only evaluated when a later `coinbase-paper` command",
            "Never invent, estimate, round, or remember a price",
            "Reset only when the user explicitly asks to start over",
            "Never call live order, preview, convert, transfer, or x402 commands",
        ):
            with self.subTest(marker=marker):
                self.assertIn(marker, entry)
        self.assertNotIn("coinbase paper ", entry)
        self.assertNotIn("lock-live", entry)


if __name__ == "__main__":
    unittest.main()
