import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('release_package', Path(__file__).resolve().parents[2] / 'tools/release/package_release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleasePrivacyTests(unittest.TestCase):
    def test_css_tables_are_not_tokens_but_actual_token_shapes_are_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'sample'
            p.write_bytes(b'mask-' + b'borderimageproperties' * 3)
            release.audit(p)
            p.write_text('token="' + 'sk-' + 'a' * 40 + '"')
            with self.assertRaisesRegex(RuntimeError, 'Credential-shaped'):
                release.audit(p)
            p.write_text('fixture-private-token')
            with self.assertRaisesRegex(RuntimeError, 'saved token'):
                release.audit(p, [('saved token', 'fixture-private-token')])
            delimiter = b'-----BEGIN ' + b'PRIVATE KEY-----'
            p.write_bytes(delimiter + b'\0')
            release.audit(p)
            p.write_bytes(delimiter + b'\n' + b'A' * 64 + b'\n')
            with self.assertRaisesRegex(RuntimeError, 'Credential-shaped'):
                release.audit(p)

    def binary(self, p, literal):
        header = struct.pack('<IIIIIIII', 0xfeedfacf, 0x100000c, 0, 2, 1, 152, 0, 0)
        command = bytearray(152)
        struct.pack_into('<II', command, 0, 0x19, 152)
        struct.pack_into('<I', command, 64, 1)
        command[72:81] = b'__cstring'
        struct.pack_into('<Q', command, 72 + 40, len(literal))
        struct.pack_into('<I', command, 72 + 48, 184)
        p.write_bytes(header + command + literal)

    def test_only_diagnostic_literals_change_without_moving_binary_offsets(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'sample'
            self.binary(p, str(Path.home() / 'build/demo.c').encode() + b'\0')
            size = p.stat().st_size
            self.assertEqual(release.diagnostic_paths(p), 1)
            self.assertEqual(p.stat().st_size, size)
            self.assertIn(b'source/demo.c\0', p.read_bytes())
            release.audit(p)
            self.binary(p, str(Path.home() / 'runtime/settings.json').encode() + b'\0')
            before = p.read_bytes()
            with self.assertRaisesRegex(RuntimeError, 'Non-diagnostic'):
                release.diagnostic_paths(p)
            self.assertEqual(p.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
