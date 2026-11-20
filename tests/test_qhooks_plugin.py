"""Exercise the actual fenced mapper without installing a connector or wallet."""
import pathlib
import shutil
import subprocess
import unittest


class QHooksPlanTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "Node is required for the portable JavaScript mapper checks")
    def test_actual_markdown_plan_mapper(self):
        root = pathlib.Path(__file__).resolve().parents[1]
        result = subprocess.run(["node", "--test", "tests/qhooks_plan.test.mjs"], cwd=root, text=True, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
