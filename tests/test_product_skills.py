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
        skill = self.add_skill("coinbase-for-agents", "coinbase")
        for relative in ("references/cli.md", "plugins/example.md", "assets/data.json"):
            path = skill / relative
            path.parent.mkdir(parents=True)
            path.write_text(relative)
        self.add_skill("wallet-mcp", "wallet-example")
        builder.copy_skills(self.target)
        self.assertEqual(
            {p.relative_to(self.target) for p in self.target.rglob("*") if p.is_file()},
            {
                Path("coinbase") / p.relative_to(skill)
                for p in skill.rglob("*")
                if p.is_file()
            },
        )
        builder.validate_skills(self.target.parent)

    def test_can_select_multiple_products(self):
        self.add_skill("coinbase-for-agents", "coinbase")
        self.add_skill("wallet-mcp", "wallet-example")
        builder.copy_skills(self.target, ("coinbase-for-agents", "wallet-mcp"))
        self.assertEqual(
            {p.name for p in self.target.iterdir()}, {"coinbase", "wallet-example"}
        )
        builder.validate_skills(self.target.parent)

    def test_duplicate_skill_names_fail_before_copying(self):
        for product in ("coinbase-for-agents", "wallet-mcp"):
            self.add_skill(product, "duplicate")
        with self.assertRaisesRegex(ValueError, "duplicate skill"):
            builder.copy_skills(self.target, ("coinbase-for-agents", "wallet-mcp"))
        self.assertFalse(self.target.exists())

    def test_rejects_missing_or_empty_products(self):
        with self.assertRaisesRegex(ValueError, "product directory"):
            builder.copy_skills(self.target)
        (self.source / "coinbase-for-agents").mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, "no skills"):
            builder.copy_skills(self.target)

    def test_rejects_empty_selection_and_unsafe_product_names(self):
        for products in ((), ("../outside",), ("/tmp/outside",)):
            with self.subTest(products=products), self.assertRaises(ValueError):
                builder.copy_skills(self.target, products)

    def test_rejects_non_skill_entries(self):
        product = self.source / "coinbase-for-agents"
        product.mkdir(parents=True)
        for is_directory in (False, True):
            path = product / "not-a-skill"
            if is_directory:
                path.mkdir()
            else:
                path.touch()
            with self.subTest(is_directory=is_directory):
                with self.assertRaisesRegex(ValueError, "invalid skill entry"):
                    builder.copy_skills(self.target)
            if not is_directory:
                path.unlink()

    def test_rejects_symlinks_at_each_source_level(self):
        skill = self.add_skill("coinbase-for-agents", "coinbase")
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
                        builder.copy_skills(self.target)
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
