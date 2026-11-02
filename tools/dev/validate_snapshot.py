#!/usr/bin/env python3
import json
from pathlib import Path
import sys
from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[2]
validator = Draft202012Validator(json.loads((ROOT / "packages/protocol/snapshot.schema.json").read_text()), format_checker=FormatChecker())
errors = list(validator.iter_errors(json.load(sys.stdin)))
if errors:
    for error in errors[:8]:
        print("Invalid snapshot field:", "/".join(map(str, error.absolute_path)), error.validator, file=sys.stderr)
    raise SystemExit(1)
print("PASS: snapshot v1 schema")
