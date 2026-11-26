"""Verify a release against its matching source checkout (requires Node.js and Python 3.9+)."""
import argparse
from pathlib import Path
import subprocess


def verify(archive, expected_id, expected_version, repository=None):
    script = Path(__file__).resolve().parents[1] / 'scripts' / 'audit.js'
    args = ['node', str(script), 'verify', str(Path(archive).resolve()), expected_id, expected_version]
    if repository:
        args.append(repository)
    return subprocess.run(args, check=False).returncode


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('extension_id')
    parser.add_argument('version')
    parser.add_argument('--repository', help='Expected public HTTPS repository URL')
    args = parser.parse_args()
    raise SystemExit(verify(args.archive, args.extension_id, args.version, args.repository))
