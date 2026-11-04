import importlib.util
from pathlib import Path
import unittest
import copy

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("pet_policy", ROOT / "tools/assets/pet_policy.py")
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


class PetPolicyTests(unittest.TestCase):
    def test_unknown_grok_has_neutral_movement_without_changing_source_or_other_states(self):
        clips = {
            "idle": {"frames": ["idle/0", "idle/1"], "fps": 4, "loop": True, "motion": "none"},
            "unknown": {"frames": ["unknown/0"], "fps": 1, "loop": True, "motion": "none"},
            "offline": {"frames": ["offline/0"], "fps": 1, "loop": True},
        }
        original = copy.deepcopy(clips)
        visual = policy.compiled_clip("grok", "unknown", clips)
        self.assertEqual(visual["frames"], clips["idle"]["frames"])
        self.assertEqual((visual["fps"], visual["loop"], visual["motion"], visual["effect"]), (4, True, "none", "none"))
        visual["frames"].append("not-source")
        self.assertEqual(clips, original)
        for agent in ("codex", "claude", "deepseek"):
            self.assertIs(policy.compiled_clip(agent, "unknown", clips), clips["unknown"])
        self.assertIs(policy.compiled_clip("grok", "offline", clips), clips["offline"])
        clips["unknown"]["frames"].append("unknown/1")
        self.assertIs(policy.compiled_clip("grok", "unknown", clips), clips["unknown"])

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
