"""Launcher, packaging, and documentation contracts for the paper-only command.

Launcher-resolution tests use a temporary stub runtime, so they exercise only
bin/coinbase-paper. Package tests build real distributions and run the
extracted launcher; they need the complete runtime (paper.py, paper_cli.py,
public_data.py) and are not skipped when a file is missing.
"""

import ast
import importlib.util
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path

from test_paper_workflow import NETWORK_GUARD, ROOT, SKILL, TIMEOUT

LAUNCHER = SKILL / "bin" / "coinbase-paper"
BUILDER = ROOT / "scripts" / "build-distributions.py"
VERSION = "1.2.0"
RUNTIME_FILES = (
    "bin/coinbase-paper",
    "scripts/paper.py",
    "scripts/paper_cli.py",
    "scripts/public_data.py",
)
STUB_CLI = """
import json, os, sys
import paper


def main(argv=None):
    print(json.dumps({
        "mode": "PAPER",
        "argv": sys.argv[1:] if argv is None else argv,
        "cli": os.path.realpath(__file__),
        "paper": os.path.realpath(paper.__file__),
        "cwd": os.getcwd(),
        "no_bytecode": sys.dont_write_bytecode,
    }))
    return 3
"""
SHADOW = "import sys\nprint('SHADOW')\nsys.exit(99)\n"


def load_builder():
    sys.dont_write_bytecode = True  # keep scripts/ free of __pycache__
    spec = importlib.util.spec_from_file_location("build_distributions", BUILDER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class IsolatedProcessCase(unittest.TestCase):
    """Clean HOME, no paper env vars, a pinned python3, and a network guard."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="paper dist ")).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.home = self.tmp / "clean home"
        self.home.mkdir()
        tools = self.tmp / "tools"
        tools.mkdir()
        (tools / "python3").symlink_to(sys.executable)
        guard = self.tmp / "guard"
        guard.mkdir()
        (guard / "sitecustomize.py").write_text(NETWORK_GUARD)
        self.guard = guard
        self.env = {
            "HOME": str(self.home),
            "PATH": f"{tools}{os.pathsep}{os.defpath}",
            "PYTHONPATH": str(guard),
            "LANG": "C.UTF-8",
        }
        self.elsewhere = self.tmp / "unrelated cwd"
        self.elsewhere.mkdir()

    def run_launcher(self, command, cwd=None, env=None):
        result = subprocess.run(
            [str(part) for part in command],
            capture_output=True,
            text=True,
            cwd=cwd or self.elsewhere,
            env=env or self.env,
            timeout=TIMEOUT,
        )
        self.assertNotIn("Traceback", result.stderr)
        self.assertNotIn("ResourceWarning", result.stderr)
        return result

    def assertExecutable(self, path):
        self.assertTrue(path.is_file(), path)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode) & 0o111, 0o111, path)


class LauncherResolutionTest(IsolatedProcessCase):
    def install_stub(self, parent):
        bundle = parent / "bundle with spaces"
        (bundle / "bin").mkdir(parents=True)
        (bundle / "scripts").mkdir()
        launcher = bundle / "bin" / "coinbase-paper"
        shutil.copyfile(LAUNCHER, launcher)
        launcher.chmod(0o755)
        (bundle / "scripts" / "paper_cli.py").write_text(STUB_CLI)
        (bundle / "scripts" / "paper.py").write_text("")
        return bundle, launcher

    def test_source_launcher_is_executable_python_with_portable_shebang(self):
        self.assertExecutable(LAUNCHER)
        source = LAUNCHER.read_text()
        self.assertTrue(source.startswith("#!/usr/bin/env python3\n"))
        tree = ast.parse(source, feature_version=(3, 8))  # guard must parse
        imported = {
            alias.name
            for node in ast.walk(tree)
            if isinstance(node, (ast.Import, ast.ImportFrom))
            for alias in node.names
        }
        self.assertEqual(imported, {"json", "os", "sys", "main"})
        self.assertIn("os.path.realpath(__file__)", source)
        self.assertLess(source.index("MINIMUM_PYTHON:"), source.index("import main"))

    def test_resolves_sibling_runtime_from_any_cwd_symlink_or_python(self):
        bundle, launcher = self.install_stub(self.tmp)
        # Same-named modules in cwd and PYTHONPATH must not shadow the bundle.
        (self.elsewhere / "paper_cli.py").write_text(SHADOW)
        (self.guard / "paper_cli.py").write_text(SHADOW)
        (self.guard / "paper.py").write_text(SHADOW)
        links = self.tmp / "links dir"
        links.mkdir()
        (links / "coinbase-paper").symlink_to(launcher)
        commands = {
            "direct": [launcher],
            "symlink": [links / "coinbase-paper"],
            "python": [sys.executable, launcher],
            "relative symlink": ["./coinbase-paper"],
        }
        for name, command in commands.items():
            with self.subTest(invocation=name):
                cwd = links if name == "relative symlink" else self.elsewhere
                result = self.run_launcher([*command, "status", "--x y"], cwd=cwd)
                self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
                data = json.loads(result.stdout)
                self.assertEqual(data["argv"], ["status", "--x y"])
                self.assertEqual(
                    data["cli"], os.path.realpath(bundle / "scripts" / "paper_cli.py")
                )
                self.assertEqual(
                    data["paper"], os.path.realpath(bundle / "scripts" / "paper.py")
                )
                self.assertEqual(data["cwd"], os.path.realpath(cwd))
                self.assertTrue(data["no_bytecode"])
        self.assertEqual(list(bundle.rglob("__pycache__")), [])
        self.assertEqual(os.listdir(self.home), [])

    def test_incomplete_runtime_fails_closed_with_paper_json(self):
        bundle, launcher = self.install_stub(self.tmp)
        (bundle / "scripts" / "paper_cli.py").unlink()
        result = self.run_launcher([launcher, "doctor"])
        self.assertEqual(result.returncode, 1)
        data = json.loads(result.stdout)
        self.assertEqual(data["mode"], "PAPER")
        self.assertFalse(data["ok"])
        self.assertEqual(data["error"]["code"], "RUNTIME_INCOMPLETE")


class BuilderContractTest(unittest.TestCase):
    def setUp(self):
        self.builder = load_builder()
        self.tmp = Path(tempfile.mkdtemp(prefix="paper-builder-")).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def standalone_fixture(self):
        # Fixture only: absent runtime modules become temporary placeholders so
        # validation rules can be tested in isolation from the runtime patch.
        root = self.tmp / "bundle"
        for relative in self.builder.PAPER_FILES:
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            source = SKILL / relative
            if source.is_file():
                shutil.copy2(source, target)
            else:
                target.write_text("")
        (root / "LICENSE").write_text("license")
        return root

    def test_runtime_files_and_launcher_mode_are_allowlisted(self):
        self.assertTrue(set(RUNTIME_FILES) <= set(self.builder.PAPER_FILES))
        self.assertEqual(
            self.builder.EXECUTABLE_SKILL_FILES,
            {"coinbase-paper-trading": ("bin/coinbase-paper",)},
        )
        self.assertEqual(self.builder.paper_version(), VERSION)

    def test_validation_rejects_lost_exec_bit_state_and_extra_files(self):
        root = self.standalone_fixture()
        self.builder.validate_skills(root, standalone=True)
        launcher = root / "bin" / "coinbase-paper"
        launcher.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "not executable"):
            self.builder.validate_skills(root, standalone=True)
        launcher.chmod(0o755)
        for extra in (
            "account.sqlite3",
            "profile.json",
            "requests/6f1c2a3e-9b0d-4e57-8a2c-1d4b5e6f7a80.json",
            "scripts/notes.txt",
        ):
            with self.subTest(extra=extra):
                path = root / extra
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("{}")
                with self.assertRaises(ValueError):
                    self.builder.validate_skills(root, standalone=True)
                path.unlink()
        self.builder.validate_skills(root, standalone=True)


def build(output, *flags):
    result = subprocess.run(
        [sys.executable, str(BUILDER), str(output), *flags],
        capture_output=True,
        text=True,
        timeout=TIMEOUT,
    )
    if result.returncode:
        raise AssertionError(f"build failed: {result.stderr.strip()}")
    return output / "site"


def archive_modes(path):
    if path.name.endswith(".zip"):
        with zipfile.ZipFile(path) as archive:
            return {
                info.filename.rstrip("/"): info.external_attr >> 16
                for info in archive.infolist()
            }
    with tarfile.open(path) as archive:
        return {
            member.name: member.mode
            | (
                stat.S_IFDIR
                if member.isdir()
                else stat.S_IFREG
                if member.isfile()
                else 0
            )
            for member in archive.getmembers()
        }


def extract_zip_with_modes(path, destination):
    # zipfile does not restore permissions; apply the stored Unix modes the
    # way unzip does, after confirming every member stays inside destination.
    with zipfile.ZipFile(path) as archive:
        for info in archive.infolist():
            target = (destination / info.filename).resolve()
            if destination.resolve() not in target.parents:
                raise AssertionError(f"unsafe member: {info.filename}")
        archive.extractall(destination)
        for info in archive.infolist():
            (destination / info.filename).chmod(stat.S_IMODE(info.external_attr >> 16))


class PackagedLauncherTest(IsolatedProcessCase):
    def check_archive_modes(self, archive, package):
        modes = archive_modes(archive)
        launcher = f"{package}/bin/coinbase-paper"
        for name, value in modes.items():
            self.assertNotRegex(name, r"__pycache__|\.pyc$|\.sqlite3?$|\.db$|/requests")
            if stat.S_ISDIR(value):
                self.assertEqual(stat.S_IMODE(value), 0o755, name)
            else:
                self.assertTrue(stat.S_ISREG(value), name)
                self.assertIn(stat.S_IMODE(value), (0o644, 0o755), name)
        matches = [name for name in modes if name.endswith("bin/coinbase-paper")]
        self.assertEqual(len(matches), 1, archive)
        if package.startswith("coinbase-paper-trading"):
            self.assertEqual(matches, [launcher])
        self.assertEqual(stat.S_IMODE(modes[matches[0]]), 0o755, archive)

    def extractions(self, archives, package):
        root = self.tmp / "extract here"
        results = {}
        zip_target = root / "zip python"
        zip_target.mkdir(parents=True)
        extract_zip_with_modes(archives["zip"], zip_target)
        results["zip"] = zip_target / package
        tar_target = root / "tar python"
        tar_target.mkdir()
        with tarfile.open(archives["tar.gz"]) as archive:
            archive.extractall(tar_target, filter="data")
        results["tar"] = tar_target / package
        # Also verify with the platform tools users will typically run.
        for tool, key, argv in (
            ("unzip", "zip", ["-q", str(archives["zip"]), "-d"]),
            ("tar", "tar.gz", ["-xzf", str(archives["tar.gz"]), "-C"]),
        ):
            if shutil.which(tool):
                target = root / f"{tool} system"
                target.mkdir()
                subprocess.run([tool, *argv, str(target)], check=True, timeout=TIMEOUT)
                results[f"{tool}-system"] = target / package
        return results

    def test_zip_without_executable_mode_uses_documented_python_fallback(self):
        site = build(self.tmp / "no-mode-dist", "--paper-only")
        package = f"coinbase-paper-trading-v{VERSION}"
        target = self.tmp / "mode lost extraction"
        with zipfile.ZipFile(site / "downloads" / f"{package}.zip") as archive:
            archive.extractall(target)
        launcher = target / package / "bin" / "coinbase-paper"
        launcher.chmod(0o644)
        result = self.run_launcher([sys.executable, launcher, "doctor"])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["mode"], "PAPER")
        self.assertEqual(os.listdir(self.home), [])
        self.assertFalse(list(target.rglob("__pycache__")))

    def test_copy_tree_excludes_macos_metadata(self):
        source = self.tmp / "source"
        source.mkdir()
        (source / ".DS_Store").write_bytes(b"finder metadata")
        (source / "keep.txt").write_text("kept")
        target = self.tmp / "copied"
        load_builder().copy_tree(source, target)
        self.assertFalse((target / ".DS_Store").exists())
        self.assertEqual((target / "keep.txt").read_text(), "kept")

    def test_paper_only_archives_extract_and_run_from_any_cwd(self):
        site = build(self.tmp / "dist", "--paper-only")
        package = f"coinbase-paper-trading-v{VERSION}"
        archives = {
            suffix: site / "downloads" / f"{package}.{suffix}"
            for suffix in ("zip", "tar.gz")
        }
        for archive in archives.values():
            self.check_archive_modes(archive, package)
        self.assertExecutable(site / "packages" / package / "bin" / "coinbase-paper")
        for name, extracted in self.extractions(archives, package).items():
            with self.subTest(extraction=name):
                launcher = extracted / "bin" / "coinbase-paper"
                self.assertExecutable(launcher)
                for relative in RUNTIME_FILES:
                    self.assertEqual(
                        (extracted / relative).read_bytes(),
                        (SKILL / relative).read_bytes(),
                    )
                version = self.run_launcher([launcher, "--version"])
                self.assertEqual(version.returncode, 0, version.stderr)
                self.assertIn(VERSION, version.stdout)
                help_text = self.run_launcher([launcher, "--help"])
                self.assertEqual(help_text.returncode, 0, help_text.stderr)
                self.assertIn("buy", help_text.stdout)
                self.assertEqual(os.listdir(self.home), [], "help/version wrote state")
                data_dir = self.tmp / f"data {name}"
                doctor = self.run_launcher([launcher, "--data-dir", data_dir, "doctor"])
                report = json.loads(doctor.stdout)
                self.assertEqual(report["mode"], "PAPER")
                for state in ("account.sqlite3", "profile.json", "requests"):
                    self.assertFalse((data_dir / state).exists(), state)
                self.assertEqual(list(extracted.rglob("__pycache__")), [])

    def test_full_plugins_include_executable_launcher_reproducibly(self):
        sites = [build(self.tmp / name / "dist") for name in ("a", "b")]
        builder = load_builder()
        packages = sorted((sites[0] / "packages").iterdir())
        self.assertEqual(len(packages), 3)
        for package in packages:
            skills = list(package.rglob("coinbase-paper-trading/SKILL.md"))
            self.assertEqual(len(skills), 1, package)
            skill = skills[0].parent
            self.assertEqual(
                {
                    path.relative_to(skill).as_posix()
                    for path in skill.rglob("*")
                    if path.is_file()
                },
                set(builder.PAPER_FILES),
            )
            self.assertExecutable(skill / "bin" / "coinbase-paper")
            for relative in RUNTIME_FILES:
                self.assertEqual(
                    (skill / relative).read_bytes(), (SKILL / relative).read_bytes()
                )
        downloads = [site / "downloads" for site in sites]
        archives = sorted(
            path for path in downloads[0].iterdir() if path.name != "SHA256SUMS"
        )
        self.assertEqual(len(archives), 6)
        for archive in archives:
            with self.subTest(archive=archive.name):
                package = archive.name.removesuffix(".zip").removesuffix(".tar.gz")
                self.check_archive_modes(archive, package)
                self.assertEqual(
                    archive.read_bytes(), (downloads[1] / archive.name).read_bytes()
                )


class CliFirstDocumentationTest(unittest.TestCase):
    """Static drift checks; not evidence of model routing or host registration."""

    def read(self, relative):
        return (ROOT / relative).read_text()

    def paper_docs(self):
        return {
            path.relative_to(ROOT).as_posix(): path.read_text()
            for path in sorted(SKILL.rglob("*.md"))
        }

    def test_skill_is_cli_first_with_explicit_requirements(self):
        skill = self.read("skills/coinbase-paper-trading/SKILL.md")
        header = re.match(r"^---\n(.*?)\n---\n", skill, re.DOTALL).group(1)
        self.assertIn(f"version: {VERSION}", header)
        self.assertIn("coinbase-paper command", header)
        self.assertIn("no login, API key, or MCP connection", header)
        self.assertIn("public HTTPS", header)
        for phrase in (
            "bin/coinbase-paper",
            "absolute path",
            "--data-dir ABS",
            "COINBASE_PAPER_HOME",
            "$XDG_DATA_HOME/coinbase-paper",
            "~/.local/share/coinbase-paper",
            "Python 3.11+",
            "same `--request-id`",
            "Never create a new ID to retry",
            "optional legacy/advanced route",
            "never mix it with a CLI retry",
        ):
            self.assertIn(phrase, skill)
        self.assertLess(skill.index("## Run the command"), skill.index("## Set up"))

    def test_command_reference_covers_contract(self):
        cli = self.read("skills/coinbase-paper-trading/references/cli.md")
        order = [
            cli.index("1. `--data-dir ABS`"),
            cli.index("2. `COINBASE_PAPER_HOME`"),
            cli.index("3. `$XDG_DATA_HOME/coinbase-paper`"),
            cli.index("4. `~/.local/share/coinbase-paper`"),
        ]
        self.assertEqual(order, sorted(order))
        for phrase in (
            "relative paths are rejected",
            "account.sqlite3",
            "profile.json",
            "requests/",
            "exact same command and `--request-id`",
            "same ID with different terms is rejected",
            "never used for fills or marks",
            "Create no state; use no network",
            "Nothing is added to `PATH`",
        ):
            self.assertIn(phrase, cli)

    def test_install_registration_and_credentials_are_explicit(self):
        start = self.read("skills/coinbase-paper-trading/START-HERE.md")
        host = self.read("skills/coinbase-paper-trading/references/host-setup.md")
        readme = self.read("README.md")
        self.assertIn("separate host requirement", start)
        self.assertIn("Installing files is not registration", host)
        self.assertIn("Register for fresh bots (host requirement)", host)
        self.assertIn("keeps permissions", host)
        for phrase in (
            "bin/coinbase-paper",
            "--data-dir ABS",
            "COINBASE_PAPER_HOME",
            "Python 3.11+",
            "no login, API key, live credentials",
            "exact same `--request-id`",
            "optional legacy route",
            "separate host requirement",
            "Nothing is added to `PATH`",
        ):
            self.assertIn(phrase, readme)

    def test_discovery_routes_to_the_command(self):
        entry = self.read("skills/coinbase/SKILL.md")
        self.assertIn("`coinbase-paper` command", entry)
        self.assertLess(
            entry.index("Resolve paper versus live"),
            entry.index("Select the interface"),
        )
        market = self.read("skills/coinbase-market-data/SKILL.md")
        self.assertIn("`coinbase-paper` command", market)
        self.assertIn("optional legacy route", market)
        changelog = self.read("CHANGELOG.md")
        self.assertIn(f"Paper-trading skill {VERSION}", changelog)
        self.assertIn("not a plugin release", changelog)

    def test_no_installers_or_path_mutation_in_docs(self):
        documents = {**self.paper_docs(), "README.md": self.read("README.md")}
        for name, text in documents.items():
            with self.subTest(document=name):
                self.assertNotRegex(text, r"curl[^\n]*\|\s*(sudo\s+)?(ba|z)?sh\b")
                self.assertNotRegex(text, r"wget[^\n]*\|\s*(ba|z)?sh\b")
                self.assertNotRegex(text, r"export PATH|ln -s [^\n]*/bin/")
                if name.startswith("skills/"):
                    self.assertNotRegex(text, r"pip3? install|npm install")

    def test_ci_runs_supported_pythons_with_resource_warnings(self):
        workflow = self.read(".github/workflows/check-distributions.yml")
        self.assertIn('python: ["3.11", "3.13", "3.14"]', workflow)
        self.assertIn("-W error::ResourceWarning", workflow)
        self.assertIn("skills/coinbase-paper-trading/bin/coinbase-paper", workflow)


if __name__ == "__main__":
    unittest.main()
