import unittest
from pathlib import Path


SKILLS = Path(__file__).resolve().parents[1] / "skills"
PRODUCTS = ("coinbase-cli", "coinbase-mcp")
CAPABILITIES = {
    "market-data",
    "portfolios",
    "trading",
    "convert",
    "equities",
    "futures",
    "x402",
}


class CoinbaseProductsTests(unittest.TestCase):
    def skill_text(self, product, capability=None):
        name = f"{product}-{capability}" if capability else product
        return (SKILLS / product / name / "SKILL.md").read_text()

    def test_products_have_self_contained_skills_without_interface_references(self):
        self.assertFalse((SKILLS / "coinbase-for-agents").exists())
        for product in PRODUCTS:
            capabilities = CAPABILITIES | (
                {"watch"} if product == "coinbase-cli" else set()
            )
            expected = {product} | {f"{product}-{name}" for name in capabilities}
            self.assertEqual(
                {path.name for path in (SKILLS / product).iterdir()}, expected
            )
            for name in expected:
                with self.subTest(skill=name):
                    directory = SKILLS / product / name
                    self.assertEqual(
                        {path.name for path in directory.iterdir()}, {"SKILL.md"}
                    )
                    text = (directory / "SKILL.md").read_text()
                    self.assertIn(f"name: {name}\n", text)
                    self.assertNotIn("references/", text)
                    other = (
                        "coinbase-mcp" if product == "coinbase-cli" else "coinbase-cli"
                    )
                    self.assertNotIn(f"](../{other}", text)
                    if name != product:
                        self.assertIn(f"](../{product}/SKILL.md)", text)
                        self.assertIn(
                            f"## {product.removeprefix('coinbase-').upper()} execution",
                            text,
                        )

    def test_product_setup_keeps_authentication_and_execution_separate(self):
        cli = self.skill_text("coinbase-cli")
        mcp = self.skill_text("coinbase-mcp")
        for marker in (
            "Node.js 22+",
            "@coinbase/coinbase-cli",
            "--key-file",
            "COINBASE_NO_HISTORY=1",
            "does not display raw `@file` bodies",
            "not the hosted Coinbase MCP product",
        ):
            self.assertIn(marker, cli)
        for marker in (
            "https://agents.coinbase.com/mcp",
            "native Streamable HTTP/OAuth flow",
            "PKCE",
            "coinbase_portfolios_list` with `{}`",
            "Never impersonate another client",
            "https://accounts.coinbase.com/security/connections",
        ):
            self.assertIn(marker, mcp)
        for path in (SKILLS / "coinbase-mcp").rglob("SKILL.md"):
            self.assertNotIn("```sh", path.read_text())
            self.assertNotIn("npm install", path.read_text())

    def test_both_products_keep_financial_safety_rules(self):
        safeguards = {
            "trading": (
                "Preview is not authorization",
                "Generate and retain a unique `client_order_id` before submission",
                "Acceptance/order ID is not a fill",
                "never switch interface/environment or blindly generate another ID",
            ),
            "portfolios": (
                "Delete only the explicitly selected empty portfolio",
                "A timeout does not prove that a transfer or portfolio change failed",
                "Do not invent an idempotency field",
            ),
            "convert": (
                "Quoting is not conversion approval",
                "do not request and execute a new quote as a retry",
                "Never switch interfaces to retry",
            ),
            "equities": (
                "whole-share limit orders",
                "If the user requires a preview, stop",
                "Retain `client_order_id` before submission",
            ),
            "futures": (
                "Futures require the eligible default portfolio",
                "`base_size` in contracts, not `quote_size`",
                "Do not substitute an IOC limit for a requested market order",
            ),
            "x402": (
                "5 USDC per-payment cap",
                "1000000 = 1 USDC",
                "retain the original `idempotency_key`",
                "Never show it in chat/logs or forward it across origins",
                "keep an unknown-outcome reservation",
            ),
        }
        for product in PRODUCTS:
            entry = self.skill_text(product)
            self.assertIn(
                "Installation and authentication do not authorize financial actions",
                entry,
            )
            self.assertIn(
                "never switch interfaces or generate a fresh identifier", entry
            )
            for capability, markers in safeguards.items():
                text = self.skill_text(product, capability)
                with self.subTest(product=product, capability=capability):
                    for marker in markers:
                        self.assertIn(marker, text)

    def test_capabilities_include_product_specific_commands_or_tools(self):
        for capability in CAPABILITIES:
            with self.subTest(capability=capability):
                self.assertIn("coinbase ", self.skill_text("coinbase-cli", capability))
                self.assertIn("`coinbase_", self.skill_text("coinbase-mcp", capability))

    def test_monitoring_is_cli_only_and_mcp_explains_limits(self):
        watch = self.skill_text("coinbase-cli", "watch")
        self.assertIn("--until-timeout", watch)
        self.assertIn(
            "Every nonzero/unknown outcome must block follow-up actions", watch
        )
        self.assertIn("interruption/EOF is not a match", watch)
        mcp = self.skill_text("coinbase-mcp")
        self.assertIn("has no streaming watch subscription", mcp)
        self.assertIn("Neither is automatically authorized by a watch request", mcp)
        self.assertIn("Never switch as recovery for an uncertain order or payment", mcp)


if __name__ == "__main__":
    unittest.main()
