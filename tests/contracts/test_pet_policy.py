import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("pet_policy", ROOT / "tools/assets/pet_policy.py")
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


class PetPolicyTests(unittest.TestCase):
    def test_only_grok_error_overrides_source_loop(self):
        self.assertFalse(policy.compiled_loop("grok", "error", True))
        for agent in ("codex", "claude", "deepseek"):
            self.assertTrue(policy.compiled_loop(agent, "error", True))
        for state in ("idle", "running", "waiting", "offline", "unknown"):
            self.assertTrue(policy.compiled_loop("grok", state, True))
        self.assertFalse(policy.compiled_loop("grok", "celebrate", False))

    def test_four_provider_catalog_keeps_three_visible_pet_budget(self):
        size = 57 * 112 * 112 * 3
        budget = policy.catalog_budget([size] * 4)
        self.assertGreater(budget["catalog_pixel_bytes"], 8 * 1024 * 1024)
        self.assertEqual(budget["worst_visible_pixel_bytes"], size * 3)
        self.assertLess(budget["worst_visible_pixel_bytes"], budget["visible_pixel_budget_bytes"])
        with self.assertRaisesRegex(ValueError, "visible pet pixel budget"):
            policy.catalog_budget([3 * 1024 * 1024] * 3)


if __name__ == "__main__":
    unittest.main()
