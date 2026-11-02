import json
from pathlib import Path
import re
import subprocess
import unittest
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[2]


class SettingsContractTests(unittest.TestCase):
    def test_persisted_payload_and_theme_vocabulary_match_native_clients(self):
        schema = json.loads((ROOT / "packages/protocol/settings.schema.json").read_text())
        code = "import {SettingsStore} from './apps/gateway/src/settings.ts';let s=new SettingsStore();s.update({appearance:{theme:'comic'},device:{brightness:40,transport:'relay',relay_url:'wss://example.com/relay'}});console.log(JSON.stringify(s.current()));"
        output = subprocess.run([str(ROOT / ".tools/bin/bun"), "-e", code], cwd=ROOT, text=True, capture_output=True, check=True)
        Draft202012Validator(schema).validate(json.loads(output.stdout))
        identifiers = schema["properties"]["appearance"]["properties"]["theme"]["enum"]
        native = (ROOT / "packages/ui/src/ac_theme.c").read_text()
        actual = re.search(r'static const char \*slugs\[\]=\{([^}]+)\}', native).group(1)
        self.assertEqual(re.findall(r'"([a-z]+)"', actual), identifiers)
        transport = (ROOT / "apps/simulator/ac_gateway_client.m").read_text()
        for identifier in identifiers:
            self.assertIn('@"' + identifier + '"', transport)


if __name__ == "__main__":
    unittest.main()
