import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from jsonschema import ValidationError
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("validate_pet", ROOT / "tools/assets/validate_pet.py")
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)


class PetContractTests(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads((ROOT / "examples/pets/pet.example.json").read_text(encoding="utf-8"))

    def test_static_pack_and_cross_clip_reuse(self):
        paths, size = validator.validate_manifest(self.manifest)
        self.assertEqual(paths, {"poster.png"})
        self.assertEqual(size, 37632)

    def test_required_states_and_numeric_limits(self):
        variants = []
        missing = copy.deepcopy(self.manifest)
        del missing["clips"]["unknown"]
        variants.append(missing)
        for fps in (0, 13, 8.5):
            bad = copy.deepcopy(self.manifest)
            bad["clips"]["idle"]["fps"] = fps
            variants.append(bad)
        for frame_count in (0, 17):
            bad = copy.deepcopy(self.manifest)
            bad["clips"]["running"]["frames"] = ["poster.png"] * frame_count
            variants.append(bad)
        for bad in variants:
            with self.subTest(manifest=bad), self.assertRaises(ValidationError):
                validator.validate_manifest(bad)

    def test_geometry_and_paths(self):
        bad = copy.deepcopy(self.manifest)
        bad["canvas"]["width"] = 256
        with self.assertRaises(ValidationError):
            validator.validate_manifest(bad)
        for path in ("../secret.png", "/tmp/frame.png", "idle/../frame.png", "https://example.org/a.png", "frame.gif"):
            bad = copy.deepcopy(self.manifest)
            bad["poster"] = path
            with self.subTest(path=path), self.assertRaises(ValidationError):
                validator.validate_manifest(bad)

    def test_optional_celebration_must_not_loop(self):
        self.manifest["clips"]["celebrate"] = {"frames": ["poster.png"], "fps": 8, "loop": False}
        validator.validate_manifest(self.manifest)
        self.manifest["clips"]["celebrate"]["loop"] = True
        with self.assertRaises(ValidationError):
            validator.validate_manifest(self.manifest)

    def test_total_unique_frame_limit(self):
        for state in self.manifest["clips"]:
            self.manifest["clips"][state]["frames"] = [f"{state}/{i:03}.png" for i in range(16)]
        with self.assertRaisesRegex(ValueError, "64 unique"):
            validator.validate_manifest(self.manifest)

    def test_single_frame_with_motion_and_effect(self):
        clip = self.manifest["clips"]["running"]
        clip["motion"] = "bob"
        clip["effect"] = "activity_dots"
        paths, size = validator.validate_manifest(self.manifest)
        self.assertEqual(len(paths), 1)
        self.assertEqual(size, 37632)

    def test_old_manifests_can_omit_visual_presets(self):
        for clip in self.manifest["clips"].values():
            clip.pop("motion", None)
            clip.pop("effect", None)
        validator.validate_manifest(self.manifest)

    def test_presets_reject_unknown_or_executable_values(self):
        for key, value in (("motion", "fly"), ("motion", "https://example.org/a.js"), ("effect", "<script>")):
            bad = copy.deepcopy(self.manifest)
            bad["clips"]["running"][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValidationError):
                validator.validate_manifest(bad)

    def test_decodes_png_and_checks_real_dimensions_alpha_and_margin(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "poster.png"
            img = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
            img.putpixel((64, 64), (0, 255, 255, 255))
            img.save(path)
            validator.validate_files(root, {"poster.png"})
            for image in (Image.new("RGB", (128, 128)), Image.new("RGBA", (256, 256)), Image.new("RGBA", (128, 128), (0, 0, 0, 255))):
                image.save(path)
                with self.assertRaises(ValueError):
                    validator.validate_files(root, {"poster.png"})

    def test_symlink_cannot_escape_pack(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pack = root / "pack"
            pack.mkdir()
            (root / "outside.png").touch()
            (pack / "poster.png").symlink_to(root / "outside.png")
            with self.assertRaisesRegex(ValueError, "escapes"):
                validator.validate_files(pack, {"poster.png"})


if __name__ == "__main__":
    unittest.main()
