"""Account continuity and paper-only packaging, not host/model certification."""

import hashlib
import json
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
import uuid
import zipfile
from pathlib import Path

from test_paper_workflow import ENGINE, ROOT, SKILL, TIMEOUT, PaperCLITestCase, book

VERSION = "1.2.0"


class ProfileTest(PaperCLITestCase):
    def setUp(self):
        super().setUp()
        self.profile = self.tmp / "profiles" / "default.json"

    def bind(self, account_id, state=None, profile=None):
        return self.ok(
            [
                "bind",
                "--profile",
                str(profile or self.profile),
                "--account-id",
                account_id,
            ],
            state=state,
        )

    def profile_command(self, args, profile=None, engine=ENGINE):
        return [
            sys.executable,
            str(engine),
            "--profile",
            str(profile or self.profile),
            *args,
        ]

    def via_profile(self, args, error=None, **kwargs):
        process = subprocess.run(
            self.profile_command(args, **kwargs),
            capture_output=True,
            text=True,
            cwd=self.tmp,
            env=self.env,
            timeout=TIMEOUT,
        )
        self.assertNotIn("Traceback", process.stderr)
        self.assertNotIn("ResourceWarning", process.stderr)
        data = self.parse(process.stdout, process.stderr)
        self.assertEqual(data["mode"], "PAPER")
        if error:
            self.assertNotEqual(process.returncode, 0, data)
            self.assertEqual(data["error"]["code"], error, data)
        else:
            self.assertEqual(process.returncode, 0, data)
        return data

    def request_file(self, account):
        return self.write_json(
            self.request(
                account, "BUY", book([("99", "10")], [("100", "10")]), base_size="1"
            )
        )

    def commands_for(self, account):
        return [
            ["doctor"],
            ["status"],
            ["history"],
            ["trade", "--request", str(self.request_file(account))],
            ["backup", "--output", str(self.tmp / "copy.sqlite3")],
        ]

    def test_bind_pins_existing_identity_without_touching_balances(self):
        account = self.init()
        before = self.state.read_bytes()
        result = self.bind(account)
        self.assertTrue(result["created"])
        self.assertEqual(self.state.read_bytes(), before)
        self.assertEqual(
            json.loads(self.profile.read_text()),
            {"version": 1, "state": str(self.state), "account_id": account},
        )
        self.assertEqual(stat.S_IMODE(self.profile.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.profile.parent.stat().st_mode), 0o700)
        self.assertEqual(self.via_profile(["doctor"])["account_id"], account)
        self.assertFalse(self.bind(account)["created"])
        self.assertEqual(self.state.read_bytes(), before)
        self.assertEqual(list(self.profile.parent.glob(".*.tmp")), [])

    def test_bind_requires_existing_state_and_verified_identity(self):
        expected = f"paper-{uuid.uuid4()}"
        args = ["bind", "--profile", str(self.profile), "--account-id", expected]
        self.assertEqual(self.err(args)["error"]["code"], "STATE_NOT_FOUND")
        self.assertFalse(self.state.exists())
        self.init()
        before = self.state.read_bytes()
        self.assertEqual(self.err(args)["error"]["code"], "ACCOUNT_MISMATCH")
        self.assertFalse(self.profile.exists())
        self.assertEqual(self.state.read_bytes(), before)

    def test_different_existing_binding_is_not_overwritten(self):
        first = self.init()
        self.bind(first)
        before = self.profile.read_bytes()
        other = self.tmp / "other.sqlite3"
        second = self.init(state=other)
        result = self.err(
            ["bind", "--profile", str(self.profile), "--account-id", second],
            state=other,
        )
        self.assertEqual(result["error"]["code"], "PROFILE_EXISTS")
        self.assertEqual(self.profile.read_bytes(), before)
        self.assertEqual(self.via_profile(["status"])["account_id"], first)

    def test_missing_profile_never_initializes_or_falls_back(self):
        self.via_profile(["doctor"], error="PROFILE_NOT_FOUND")
        self.via_profile(["status"], error="PROFILE_NOT_FOUND")
        self.via_profile(["init"], error="INVALID_ARGUMENT")
        self.assertFalse(self.state.exists())
        self.assertFalse(self.profile.exists())

    def test_missing_bound_state_blocks_all_commands(self):
        account = self.init()
        self.bind(account)
        before = self.profile.read_bytes()
        self.state.rename(self.tmp / "retained.sqlite3")
        for command in self.commands_for(account):
            with self.subTest(command=command[0]):
                self.via_profile(command, error="STATE_NOT_FOUND")
        self.via_profile(["init"], error="INVALID_ARGUMENT")
        self.assertFalse(self.state.exists())
        self.assertFalse((self.tmp / "copy.sqlite3").exists())
        self.assertEqual(self.profile.read_bytes(), before)

    def test_replaced_database_identity_blocks_reads_writes_and_backup(self):
        account = self.init()
        self.bind(account)
        self.state.rename(self.tmp / "original.sqlite3")
        replacement = self.init(cash="77")
        before = self.state.read_bytes()
        # Even a request that matches the replacement DB cannot bypass the profile.
        for command in self.commands_for(replacement):
            with self.subTest(command=command[0]):
                self.via_profile(command, error="ACCOUNT_MISMATCH")
        self.assertEqual(self.state.read_bytes(), before)
        self.assertFalse((self.tmp / "copy.sqlite3").exists())

    def test_new_process_resumes_filled_account_and_saved_request(self):
        account = self.init()
        self.bind(account)
        request = self.request_file(account)
        first = self.via_profile(["trade", "--request", str(request)])
        self.assertEqual(first["cash"], "9899.90")
        self.assertEqual(self.via_profile(["trade", "--request", str(request)]), first)
        current = self.via_profile(["status"])
        self.assertEqual(current["account_id"], account)
        self.assertEqual(current["cash"], "9899.90")
        self.assertEqual(len(current["positions"]), 1)
        self.assertEqual(self.via_profile(["history"])["orders"], [first])
        self.assertEqual(current, self.ok(["status"]))
        self.assertFalse(self.bind(account)["created"])

    def test_missing_or_corrupt_files_do_not_get_repaired(self):
        account = self.init()
        self.bind(account)
        self.state.write_bytes(b"not a database")
        self.via_profile(["status"], error="STATE_INVALID")
        self.assertEqual(self.state.read_bytes(), b"not a database")
        for payload in ("{", '{"version":1,"version":1}', "null"):
            with self.subTest(payload=payload):
                self.profile.write_text(payload)
                self.via_profile(["doctor"], error="PROFILE_INVALID")
                self.assertEqual(self.profile.read_text(), payload)

    def test_profile_directory_and_non_directory_parent_fail_closed(self):
        account = self.init()
        self.profile.mkdir(parents=True)
        self.via_profile(["status"], error="PROFILE_INVALID")
        blocked_parent = self.tmp / "regular-file"
        blocked_parent.write_text("preserve me")
        target = blocked_parent / "profile.json"
        result = self.err(["bind", "--profile", str(target), "--account-id", account])
        self.assertEqual(result["error"]["code"], "PROFILE_PATH_UNAVAILABLE")
        self.assertEqual(blocked_parent.read_text(), "preserve me")
        self.assertEqual(self.ok(["status"])["account_id"], account)

    def test_bind_refuses_non_json_existing_file_without_overwrite(self):
        account = self.init()
        self.profile.parent.mkdir()
        self.profile.write_text("existing unrelated notes")
        result = self.err(
            ["bind", "--profile", str(self.profile), "--account-id", account]
        )
        self.assertEqual(result["error"]["code"], "PROFILE_INVALID")
        self.assertEqual(self.profile.read_text(), "existing unrelated notes")
        self.assertEqual(list(self.profile.parent.glob(".*.tmp")), [])

    def test_profile_format_is_strict(self):
        account = self.init()
        self.bind(account)
        good = json.loads(self.profile.read_text())
        changes = [
            ({"version": True}, "PROFILE_INVALID"),
            ({"version": 2}, "PROFILE_INVALID"),
            ({"version": "1"}, "PROFILE_INVALID"),
            ({"extra": "ignored?"}, "PROFILE_INVALID"),
            ({"account_id": "live-account"}, "PROFILE_INVALID"),
            ({"state": 123}, "PROFILE_INVALID"),
            ({"state": "relative.sqlite3"}, "INVALID_PATH"),
        ]
        for delta, error in changes:
            with self.subTest(delta=delta):
                self.profile.write_text(json.dumps({**good, **delta}))
                self.via_profile(["status"], error=error)

    def test_profile_paths_cannot_be_relative_symlinks_or_in_skill(self):
        account = self.init()
        self.bind(account)
        alias = self.tmp / "alias.json"
        alias.symlink_to(self.profile)
        for path in (Path("relative.json"), alias, SKILL / "forbidden.json"):
            with self.subTest(path=str(path)):
                self.via_profile(["status"], profile=path, error="INVALID_PATH")
        args = ["bind", "--profile", str(alias), "--account-id", account]
        self.assertEqual(self.err(args)["error"]["code"], "INVALID_PATH")

    def test_state_and_profile_are_mutually_exclusive_except_bind(self):
        account = self.init()
        self.bind(account)
        self.assertEqual(
            self.err(["status", "--profile", str(self.profile)])["error"]["code"],
            "INVALID_ARGUMENT",
        )
        self.via_profile(["init"], error="INVALID_ARGUMENT")
        # Global arguments also work after the command.
        process = subprocess.run(
            [sys.executable, str(ENGINE), "status", "--profile", str(self.profile)],
            capture_output=True,
            text=True,
            env=self.env,
            timeout=TIMEOUT,
        )
        self.assertEqual(process.returncode, 0, process.stdout)
        self.assertEqual(json.loads(process.stdout)["account_id"], account)

    def test_concurrent_bind_of_same_account_is_idempotent(self):
        account = self.init()
        args = ["bind", "--profile", str(self.profile), "--account-id", account]
        results = self.collect([self.popen(args) for _ in range(4)])
        self.assertTrue(all(code == 0 for code, _ in results), results)
        self.assertEqual(sum(data["created"] for _, data in results), 1)
        self.assertEqual(self.via_profile(["doctor"])["account_id"], account)
        self.assertEqual(list(self.profile.parent.glob(".*.tmp")), [])

    def test_concurrent_different_bindings_select_only_one_account(self):
        first = self.init()
        other = self.tmp / "other.sqlite3"
        second = self.init(state=other)
        processes = [
            self.popen(
                ["bind", "--profile", str(self.profile), "--account-id", account],
                state=state,
            )
            for account, state in ((first, self.state), (second, other))
        ]
        results = self.collect(processes)
        self.assertEqual(sorted(code for code, _ in results), [0, 1])
        failed = [data for code, data in results if code][0]
        self.assertEqual(failed["error"]["code"], "PROFILE_EXISTS")
        winner = [data for code, data in results if not code][0]
        self.assertEqual(
            self.via_profile(["doctor"])["account_id"], winner["account_id"]
        )

    def test_concurrent_profile_trade_fills_only_once(self):
        account = self.init()
        self.bind(account)
        command = self.profile_command(
            ["trade", "--request", str(self.request_file(account))]
        )
        processes = [
            subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=self.env,
                cwd=self.tmp,
            )
            for _ in range(4)
        ]
        results = self.collect(processes)
        self.assertTrue(all(code == 0 for code, _ in results), results)
        self.assertTrue(all(data == results[0][1] for _, data in results))
        self.assertEqual(self.via_profile(["history"])["order_count"], 1)
        self.assertEqual(self.via_profile(["status"])["cash"], "9899.90")

    def test_relocated_code_keeps_same_binding_and_account(self):
        account = self.init()
        self.bind(account)
        installed = self.tmp / "new-code"
        shutil.copytree(SKILL, installed, ignore=shutil.ignore_patterns("__pycache__"))
        result = self.via_profile(["status"], engine=installed / "scripts" / "paper.py")
        self.assertEqual(result["account_id"], account)
        self.assertEqual(result, self.ok(["status"]))

    def test_backup_requires_deliberate_new_binding_to_restore(self):
        account = self.init()
        self.bind(account)
        self.via_profile(["trade", "--request", str(self.request_file(account))])
        backup = self.tmp / "backup.sqlite3"
        self.via_profile(["backup", "--output", str(backup)])
        original_binding = self.profile.read_bytes()
        self.assertEqual(
            self.err(
                ["bind", "--profile", str(self.profile), "--account-id", account],
                state=backup,
            )["error"]["code"],
            "PROFILE_EXISTS",
        )
        restored = self.tmp / "restored.json"
        self.bind(account, state=backup, profile=restored)
        self.assertEqual(
            self.via_profile(["status"], profile=restored), self.via_profile(["status"])
        )
        self.assertEqual(self.profile.read_bytes(), original_binding)


class PaperOnlyPackageTest(unittest.TestCase):
    FILES = {
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
        "LICENSE",
        "SHA256SUMS",
    }

    def test_bundle_is_self_contained_reproducible_and_uses_canonical_source(self):
        with tempfile.TemporaryDirectory(prefix="paper-package-") as directory:
            root = Path(directory).resolve()
            builds = []
            for name in ("a", "b"):
                output = root / name
                result = subprocess.run(
                    [
                        sys.executable,
                        str(ROOT / "scripts/build-distributions.py"),
                        str(output),
                        "--paper-only",
                    ],
                    capture_output=True,
                    text=True,
                    timeout=TIMEOUT,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                packages = list((output / "site/packages").iterdir())
                self.assertEqual(len(packages), 1)
                package = packages[0]
                self.assertEqual(package.name, f"coinbase-paper-trading-v{VERSION}")
                self.assertEqual(
                    {
                        path.relative_to(package).as_posix()
                        for path in package.rglob("*")
                        if path.is_file()
                    },
                    self.FILES,
                )
                for relative in self.FILES - {"LICENSE", "SHA256SUMS"}:
                    self.assertEqual(
                        (package / relative).read_bytes(),
                        (SKILL / relative).read_bytes(),
                    )
                self.assertEqual(
                    (package / "LICENSE").read_bytes(), (ROOT / "LICENSE").read_bytes()
                )
                hashes = {}
                for line in (package / "SHA256SUMS").read_text().splitlines():
                    digest, relative = line.split("  ", 1)
                    hashes[relative] = digest
                    self.assertEqual(
                        hashlib.sha256((package / relative).read_bytes()).hexdigest(),
                        digest,
                    )
                self.assertEqual(set(hashes), self.FILES - {"SHA256SUMS"})
                for document in package.rglob("*.md"):
                    for target in re.findall(r"\]\(([^)]+)\)", document.read_text()):
                        target = target.split("#", 1)[0]
                        if not target or "://" in target:
                            continue
                        resolved = (document.parent / target).resolve()
                        self.assertIn(package, (resolved, *resolved.parents))
                        self.assertTrue(resolved.exists(), (document, target))
                downloads = output / "site/downloads"
                for line in (downloads / "SHA256SUMS").read_text().splitlines():
                    digest, relative = line.split("  ", 1)
                    self.assertEqual(
                        hashlib.sha256((downloads / relative).read_bytes()).hexdigest(),
                        digest,
                    )
                builds.append(downloads)
            for suffix in ("zip", "tar.gz"):
                name = f"coinbase-paper-trading-v{VERSION}.{suffix}"
                self.assertEqual(
                    (builds[0] / name).read_bytes(), (builds[1] / name).read_bytes()
                )
            with zipfile.ZipFile(
                builds[0] / f"coinbase-paper-trading-v{VERSION}.zip"
            ) as archive:
                archive.extractall(
                    root / "extracted"
                )  # Only our just-built, allowlisted archive.
            engine = (
                root / f"extracted/coinbase-paper-trading-v{VERSION}/scripts/paper.py"
            )
            result = subprocess.run(
                [
                    sys.executable,
                    str(engine),
                    "--state",
                    str(root / "account.sqlite3"),
                    "doctor",
                ],
                capture_output=True,
                text=True,
                timeout=TIMEOUT,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["state_status"], "MISSING")
            self.assertFalse((root / "account.sqlite3").exists())

    def test_requirements_and_routing_are_explicit_static_contracts(self):
        # This guards documentation drift, not actual model behavior or permissions.
        skill = (SKILL / "SKILL.md").read_text()
        guide = (SKILL / "START-HERE.md").read_text()
        host = (SKILL / "references/host-setup.md").read_text()
        connector = (SKILL / "references/connector-instructions.md").read_text()
        self.assertLess(skill.index("Required capabilities"), skill.index("## Set up"))
        for phrase in ("terminal", "Python 3.11+", "SQLite", "durable", "chat memory"):
            self.assertIn(phrase, skill)
        for phrase in (
            "stop setup",
            "ephemeral",
            "not proof",
            "never",
            "No global mode",
        ):
            self.assertIn(phrase, skill)
        self.assertIn("new conversations", guide)
        self.assertIn("Unknown persistence blocks", host)
        self.assertIn("{{SKILL_PATH}}", connector)
        self.assertIn("{{LAUNCHER_PATH}}", connector)
        self.assertIn("{{DATA_DIR}}", connector)
        self.assertIn("information/readiness", connector)
        entry = (ROOT / "skills/coinbase/SKILL.md").read_text()
        self.assertLess(
            entry.index("Resolve paper versus live"),
            entry.index("Select the interface"),
        )
        self.assertIn("no mcp server change", guide.lower())
        self.assertNotIn("../../coinbase", (SKILL / "references/mcp.md").read_text())


if __name__ == "__main__":
    unittest.main()
