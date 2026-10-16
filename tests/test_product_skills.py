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

    def add_skill(self, product, name):
        skill = self.source / product / name
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text(
            f"---\nname: {name}\ndescription: Test workflow.\n---\n"
        )
        return skill

    def test_default_selection_excludes_other_products(self):
        skill = self.add_skill("coinbase-cli", "cli-example")
        self.add_skill("coinbase-mcp", "mcp-example")
        for relative in ("references/cli.md", "plugins/example.md", "assets/data.json"):
            path = skill / relative
            path.parent.mkdir(parents=True)
            path.write_text(relative)
        self.add_skill("wallet-mcp", "wallet-example")
        builder.copy_skills(self.target)
        self.assertEqual(
            {p.relative_to(self.target) for p in self.target.rglob("*") if p.is_file()},
            {
                Path("cli-example") / p.relative_to(skill)
                for p in skill.rglob("*")
                if p.is_file()
            }
            | {Path("coinbase/SKILL.md"), Path("mcp-example/SKILL.md")},
        )
        builder.validate_skills(self.target.parent)

    def test_can_select_multiple_products(self):
        self.add_skill("coinbase-cli", "cli-example")
        self.add_skill("wallet-mcp", "wallet-example")
        builder.copy_skills(self.target, ("coinbase-cli", "wallet-mcp"))
        self.assertEqual(
            {p.name for p in self.target.iterdir()},
            {"coinbase", "cli-example", "wallet-example"},
        )
        builder.validate_skills(self.target.parent)

    def test_router_links_rebase_without_changing_source(self):
        self.add_skill("coinbase-cli", "cli-example")
        document = self.router / "SKILL.md"
        original = document.read_text() + (
            "\n[Product](../coinbase-cli/cli-example/SKILL.md#setup)\n"
            "[Docs](https://example.com/guide#setup)\n"
        )
        document.write_text(original)
        builder.copy_skills(self.target, ("coinbase-cli",))
        self.assertEqual(document.read_text(), original)
        self.assertEqual(
            (self.target / "coinbase/SKILL.md").read_text(),
            original.replace(
                "../coinbase-cli/cli-example/SKILL.md",
                "../cli-example/SKILL.md",
            ),
        )
        builder.validate_links(self.target.parent)

    def test_product_can_link_back_to_shared_router(self):
        skill = self.add_skill("coinbase-cli", "cli-example")
        document = skill / "SKILL.md"
        original = document.read_text() + "\n[Router](../../coinbase/SKILL.md)\n"
        document.write_text(original)
        builder.copy_skills(self.target, ("coinbase-cli",))
        self.assertEqual(
            (self.target / "cli-example/SKILL.md").read_text(),
            original.replace("../../coinbase/SKILL.md", "../coinbase/SKILL.md"),
        )
        builder.validate_links(self.target.parent)

    def test_links_to_unselected_products_fail(self):
        self.add_skill("coinbase-cli", "cli-example")
        self.add_skill("wallet-mcp", "wallet-example")
        document = self.router / "SKILL.md"
        document.write_text(
            document.read_text() + "\n[Wallet](../wallet-mcp/wallet-example/SKILL.md)\n"
        )
        with self.assertRaisesRegex(ValueError, "link outside selected skills"):
            builder.copy_skills(self.target, ("coinbase-cli",))

    def test_product_cannot_shadow_shared_router(self):
        self.add_skill("coinbase-cli", "coinbase")
        with self.assertRaisesRegex(ValueError, "duplicate skill"):
            builder.copy_skills(self.target, ("coinbase-cli",))

    def test_duplicate_skill_names_fail_before_copying(self):
        for product in ("coinbase-cli", "wallet-mcp"):
            self.add_skill(product, "duplicate")
        with self.assertRaisesRegex(ValueError, "duplicate skill"):
            builder.copy_skills(self.target, ("coinbase-cli", "wallet-mcp"))
        self.assertFalse(self.target.exists())

    def test_rejects_missing_or_empty_products(self):
        with self.assertRaisesRegex(ValueError, "product directory"):
            builder.copy_skills(self.target, ("coinbase-cli",))
        (self.source / "coinbase-cli").mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, "no skills"):
            builder.copy_skills(self.target, ("coinbase-cli",))

    def test_rejects_empty_selection_and_unsafe_product_names(self):
        for products in ((), ("../outside",), ("/tmp/outside",)):
            with self.subTest(products=products), self.assertRaises(ValueError):
                builder.copy_skills(self.target, products)

    def test_rejects_non_skill_entries(self):
        product = self.source / "coinbase-cli"
        product.mkdir(parents=True)
        for is_directory in (False, True):
            path = product / "not-a-skill"
            if is_directory:
                path.mkdir()
            else:
                path.touch()
            with self.subTest(is_directory=is_directory):
                with self.assertRaisesRegex(ValueError, "invalid skill entry"):
                    builder.copy_skills(self.target, ("coinbase-cli",))
            if not is_directory:
                path.unlink()

    def test_rejects_symlinks_at_each_source_level(self):
        skill = self.add_skill("coinbase-cli", "cli-example")
        for path in (skill / "reference.md", skill, skill.parent, self.source):
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
