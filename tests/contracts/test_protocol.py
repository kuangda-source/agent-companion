import copy
import json
from pathlib import Path
import unittest
from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[2]

class ProtocolTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.validator = Draft202012Validator(json.loads((ROOT / "packages/protocol/snapshot.schema.json").read_text()), format_checker=FormatChecker())
        cls.fixture = json.loads((ROOT / "examples/state_mock.json").read_text())

    def test_complete_mock_fixture(self):
        self.validator.validate(self.fixture)

    def test_unknown_and_invalid_values(self):
        s = copy.deepcopy(self.fixture)
        s["sessions"][0]["usage"]["input_tokens"] = {"value": None, "quality": "unavailable", "source": "unsupported", "observed_at": None}
        self.validator.validate(s)
        for path, invalid in [("state", "busy-ish"), ("status_quality", "trusted")]:
            bad = copy.deepcopy(s)
            bad["sessions"][0][path] = invalid
            self.assertTrue(list(self.validator.iter_errors(bad)))
        for field, value in [("input_tokens", -1), ("input_tokens", 1.5), ("context_ratio", 1.1)]:
            bad = copy.deepcopy(s)
            bad["sessions"][0]["usage"][field]["value"] = value
            self.assertTrue(list(self.validator.iter_errors(bad)))
        s["schema_version"] = 2
        self.assertTrue(list(self.validator.iter_errors(s)))

    def test_daily_statistics_missing_sources_are_null_and_counts_are_integral(self):
        s = copy.deepcopy(self.fixture)
        for a in s["token_statistics"]["agents"]:
            if a["id"] == "claude": a["available"] = False
        for day in s["token_statistics"]["days"]: day["tokens"]["claude"] = None
        self.validator.validate(s)
        for value in [-1, 0.5, "100"]:
            s["token_statistics"]["days"][0]["tokens"]["codex"] = value
            self.assertTrue(list(self.validator.iter_errors(s)))

if __name__ == "__main__":
    unittest.main()
