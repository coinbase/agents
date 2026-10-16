import importlib.util
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "build_distributions", ROOT / "scripts/build-distributions.py"
)
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


class ProductSkillsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "skills"
        self.router = self.source / "coinbase"
        self.router.mkdir(parents=True)
        (self.router / "SKILL.md").write_text(
            "---\nname: coinbase\ndescription: Choose a product.\n---\n"
        )
        self.target = self.root / "package/skills"
        root_patch = patch.object(builder, "ROOT", self.root)
        root_patch.start()
        self.addCleanup(root_patch.stop)

    def add_skill(self, name):
        skill = self.source / name
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text(
            f"---\nname: {name}\ndescription: Test workflow.\n---\n"
        )
        return skill

    def test_default_selection_excludes_other_products(self):
        skill = self.add_skill("coinbase-cli")
        self.add_skill("coinbase-mcp")
        for relative in ("references/cli.md", "plugins/example.md", "assets/data.json"):
            path = skill / relative
            path.parent.mkdir(parents=True)
            path.write_text(relative)
        self.add_skill("wallet-mcp")
        builder.copy_skills(self.target)
        self.assertEqual(
            {p.relative_to(self.target) for p in self.target.rglob("*") if p.is_file()},
            {
                Path("coinbase-cli") / p.relative_to(skill)
                for p in skill.rglob("*")
                if p.is_file()
            }
            | {Path("coinbase/SKILL.md"), Path("coinbase-mcp/SKILL.md")},
        )
        builder.validate_skills(self.target.parent)

    def test_can_select_multiple_products(self):
        self.add_skill("coinbase-cli")
        self.add_skill("wallet-mcp")
        builder.copy_skills(self.target, ("coinbase-cli", "wallet-mcp"))
        self.assertEqual(
            {p.name for p in self.target.iterdir()},
            {"coinbase", "coinbase-cli", "wallet-mcp"},
        )
        builder.validate_skills(self.target.parent)

    def test_router_links_preserved_without_changing_source(self):
        self.add_skill("coinbase-cli")
        document = self.router / "SKILL.md"
        original = document.read_text() + (
            "\n[Product](../coinbase-cli/SKILL.md#setup)\n"
            "[Docs](https://example.com/guide#setup)\n"
        )
        document.write_text(original)
        builder.copy_skills(self.target, ("coinbase-cli",))
        self.assertEqual(document.read_text(), original)
        self.assertEqual(
            (self.target / "coinbase/SKILL.md").read_text(),
            original,
        )
        builder.validate_links(self.target.parent)

    def test_product_can_link_back_to_shared_router(self):
        skill = self.add_skill("coinbase-cli")
        document = skill / "SKILL.md"
        original = document.read_text() + "\n[Router](../coinbase/SKILL.md)\n"
        document.write_text(original)
        builder.copy_skills(self.target, ("coinbase-cli",))
        self.assertEqual(
            (self.target / "coinbase-cli/SKILL.md").read_text(),
            original,
        )
        builder.validate_links(self.target.parent)

    def test_capability_references_and_router_links_are_copied_unchanged(self):
        skill = self.add_skill("coinbase-cli")
        entry = skill / "SKILL.md"
        entry.write_text(entry.read_text() + "\n[Trading](references/trading.md)\n")
        references = skill / "references"
        references.mkdir()
        trading = references / "trading.md"
        original = (
            "# Trading\n\n[Setup](../SKILL.md)\n[Equities](equities.md)\n"
            "[Router](../../coinbase/SKILL.md)\n"
        )
        trading.write_text(original)
        (references / "equities.md").write_text("# Equities\n\n[Trading](trading.md)\n")
        builder.copy_skills(self.target, ("coinbase-cli",))
        self.assertEqual(trading.read_text(), original)
        self.assertEqual(
            (self.target / "coinbase-cli/SKILL.md").read_text(), entry.read_text()
        )
        self.assertEqual(
            (self.target / "coinbase-cli/references/trading.md").read_text(),
            original,
        )
        builder.validate_skills(self.target.parent)
        builder.validate_links(self.target.parent)

    def test_links_to_unselected_products_fail(self):
        self.add_skill("coinbase-cli")
        self.add_skill("wallet-mcp")
        document = self.router / "SKILL.md"
        document.write_text(
            document.read_text() + "\n[Wallet](../wallet-mcp/SKILL.md)\n"
        )
        with self.assertRaisesRegex(ValueError, "link outside selected skills"):
            builder.copy_skills(self.target, ("coinbase-cli",))

    def test_product_cannot_shadow_shared_router(self):
        with self.assertRaisesRegex(ValueError, "duplicate skill"):
            builder.copy_skills(self.target, ("coinbase",))

    def test_duplicate_product_selection_fails_before_copying(self):
        self.add_skill("coinbase-cli")
        with self.assertRaisesRegex(ValueError, "duplicate skill"):
            builder.copy_skills(self.target, ("coinbase-cli", "coinbase-cli"))
        self.assertFalse(self.target.exists())

    def test_rejects_missing_or_empty_products(self):
        with self.assertRaisesRegex(ValueError, "product skill directory"):
            builder.copy_skills(self.target, ("coinbase-cli",))
        (self.source / "coinbase-cli").mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, "product skill directory"):
            builder.copy_skills(self.target, ("coinbase-cli",))

    def test_rejects_empty_selection_and_unsafe_product_names(self):
        for products in ((), ("../outside",), ("/tmp/outside",)):
            with self.subTest(products=products), self.assertRaises(ValueError):
                builder.copy_skills(self.target, products)

    def test_rejects_nested_product_container_without_root_skill(self):
        nested = self.source / "coinbase-cli/coinbase-cli"
        nested.mkdir(parents=True)
        (nested / "SKILL.md").write_text(
            "---\nname: coinbase-cli\ndescription: Test workflow.\n---\n"
        )
        with self.assertRaisesRegex(ValueError, "product skill directory"):
            builder.copy_skills(self.target, ("coinbase-cli",))
        self.assertFalse(self.target.exists())

    def test_rejects_symlinks_at_each_source_level(self):
        skill = self.add_skill("coinbase-cli")
        for path in (skill / "reference.md", skill, self.router, self.source):
            with self.subTest(path=path):
                original = self.root / "saved-source"
                if path.exists():
                    path.rename(original)
                else:
                    original.write_text("external content")
                path.symlink_to(original)
                try:
                    with self.assertRaises(ValueError):
                        builder.copy_skills(self.target, ("coinbase-cli",))
                finally:
                    path.unlink()
                    original.rename(path)
                    if self.target.exists():
                        shutil.rmtree(self.target.parent)

    def test_validation_accepts_a_skill_without_cli_or_mcp_references(self):
        self.target.mkdir(parents=True)
        skill = self.target / "wallet-example"
        skill.mkdir()
        (skill / "SKILL.md").write_text(
            "---\nname: wallet-example\ndescription: A wallet workflow.\n---\n"
        )
        builder.validate_skills(self.target.parent)

    def test_validation_rejects_empty_or_invalid_skill_libraries(self):
        self.target.mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, "no skills"):
            builder.validate_skills(self.target.parent)
        skill = self.target / "example"
        skill.mkdir()
        for text in (
            "No frontmatter\n",
            "---\nname: wrong-name\ndescription: Example.\n---\n",
            "---\nname: example\ndescription:\n---\n",
        ):
            (skill / "SKILL.md").write_text(text)
            with self.subTest(text=text), self.assertRaises(ValueError):
                builder.validate_skills(self.target.parent)


if __name__ == "__main__":
    unittest.main()
