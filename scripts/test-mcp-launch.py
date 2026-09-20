"""Check that the real Xvfb launcher preserves the MCP stream boundary."""
import json
from pathlib import Path
import subprocess
import unittest


LAUNCHER = Path(__file__).with_name("mcp-launch.sh")


class LauncherTests(unittest.TestCase):
    def test_separates_diagnostics_and_preserves_exit_status(self):
        result = subprocess.run(
            [str(LAUNCHER), "/bin/sh", "-c",
             'printf "response\\n"; printf "diagnostic\\n" >&2; exit 7'],
            capture_output=True, text=True, timeout=15,
        )
        self.assertEqual(result.stdout, "response\n")
        self.assertEqual(result.stderr, "diagnostic\n")
        self.assertEqual(result.returncode, 7)

    def test_missing_command_is_explicit(self):
        result = subprocess.run(
            [str(LAUNCHER)], capture_output=True, text=True, timeout=5,
        )
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, "")
        self.assertEqual(json.loads(result.stderr)["error"], "missing_command")


if __name__ == "__main__":
    unittest.main()
