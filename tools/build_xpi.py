#!/usr/bin/env python3
"""Build installable XPI from exactly the runtime files. Python 3.9+; no external deps."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import argparse
import json

ROOT = Path(__file__).resolve().parent.parent
FILES = ['manifest.json', 'background.js', 'ui.js', 'ui.css', 'panel.html', 'compose.html', 'compose-ui.js', 'options.html', 'options.js', 'options.css', 'icons/task32.png', 'icons/task64.png', 'icons/overdue32.png', 'icons/overdue64.png']

def main():
    parser = argparse.ArgumentParser(description='Build a clean Thunderbird XPI')
    parser.add_argument('--out', default=None, help='Output .xpi path')
    args = parser.parse_args()
    manifest = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))
    name = manifest['name'].lower().replace(' ', '-')
    output = Path(args.out) if args.out else ROOT / 'dist' / f"{name}-v{manifest['version']}.xpi"
    output.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(output, 'w', ZIP_DEFLATED) as z:
        for relative in FILES:
            file = ROOT / relative
            if not file.is_file():
                raise FileNotFoundError(f'Required runtime file missing: {relative}')
            z.write(file, relative)
    with ZipFile(output) as z:
        if z.testzip() is not None:
            raise RuntimeError('ZIP integrity check failed')
        assert z.namelist()[0] == 'manifest.json'
    print(f'Built: {output} ({output.stat().st_size} bytes)')

if __name__ == '__main__':
    main()
