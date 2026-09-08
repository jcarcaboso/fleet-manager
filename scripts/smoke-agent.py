#!/usr/bin/env python3
"""Exercise a real Agent against a Server configured to scan a disposable Git source."""
import argparse
import datetime
import json
import os
from pathlib import Path
import ssl
import subprocess
import tempfile
import urllib.request
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--agent', type=Path, required=True)
parser.add_argument('--source', type=Path, required=True)
parser.add_argument('--source-container', help='Disposable test container; copies source to /var/lib/fleet/test-source with app ownership')
args = parser.parse_args()
source = args.source.resolve()
if not (source / '.fleet-agent-smoke').is_file():
    parser.error('source must be a disposable repository containing .fleet-agent-smoke')
server = os.environ['FLEET_SERVER_URL']
ca = Path(os.environ['FLEET_CA_CERT'])
token = os.environ['FLEET_OPERATOR_TOKEN']
context = ssl.create_default_context(cafile=ca)

def call(path, body=None):
    request = urllib.request.Request(server + '/operator/v1/' + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, context=context, timeout=30) as response:
        return json.load(response)

def git(*arguments):
    subprocess.run(['git', '-C', str(source), *arguments], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def publish(alias, text, empty=False):
    (source / 'fleet.yml').write_text('schema: fleet/v1\ngroups: [stable]\ntargets:\n  skills:\n    base: home\n    path: .agents/skills\nnodes:\n  '
        + alias + ':\n    targets:\n      skills:\n        groups: ' + ('[]' if empty else '[stable]') + '\n')
    skill = source / 'groups/stable/review'
    (skill / 'scripts').mkdir(parents=True, exist_ok=True)
    (skill / 'SKILL.md').write_text(text)
    executable = skill / 'scripts/check.sh'
    executable.write_text('#!/bin/sh\nprintf test\\n\n')
    executable.chmod(0o755)
    git('add', '.')
    git('commit', '-m', 'Agent smoke publication ' + uuid.uuid4().hex)
    if args.source_container:
        subprocess.run(['docker', 'exec', args.source_container, 'mkdir', '-p', '/var/lib/fleet/test-source'], check=True)
        with subprocess.Popen(['tar', '-C', str(source), '-cf', '-', '.'], stdout=subprocess.PIPE) as archive:
            subprocess.run(['docker', 'exec', '-i', args.source_container, 'tar', '-C', '/var/lib/fleet/test-source', '--no-same-owner', '-xf', '-'], stdin=archive.stdout, check=True)
            archive.stdout.close()
            assert archive.wait() == 0
    response = call('source/rescan', {})
    assert response.get('outcome') == 'accepted', 'Source publication failed: ' + str(response)

with tempfile.TemporaryDirectory(prefix='fleet-agent-e2e-') as temporary:
    root = Path(temporary)
    home = root / 'home'
    home.mkdir()
    state = root / 'state'
    alias = 'agent-' + uuid.uuid4().hex[:12]
    token_file = root / 'enrollment.json'
    token_file.write_text(json.dumps(call('enrollment-tokens', {'expiresInSeconds': 900})))
    token_file.chmod(0o600)
    def agent(*arguments, success=True):
        response = subprocess.run([str(args.agent.resolve()), '--state-dir', str(state), *arguments], capture_output=True, text=True, timeout=90)
        assert (response.returncode == 0) == success, 'Agent result unexpected: ' + response.stderr
        return response
    agent('enroll', '--server-url', server, '--ca-cert', str(ca), '--alias', alias, '--token-file', str(token_file), '--home', str(home))
    identity = json.loads(agent('status').stdout)
    target = home / '.agents/skills'
    target.mkdir(parents=True)
    (target / 'personal').mkdir()
    (target / 'personal/keep.txt').write_text('unmanaged')
    publish(alias, 'initial Skill\n')
    agent('run', '--once')
    assert (target / 'review/SKILL.md').read_text() == 'initial Skill\n'
    assert (target / 'review/scripts/check.sh').stat().st_mode & 0o111
    # Replay a durable terminal report as if its successful response was lost.
    run_path = state / 'run.json'
    saved = json.loads(run_path.read_text())
    saved['pending_report'] = {'attempt_id': saved['active']['attemptId'], 'succeeded': True, 'error_code': None}
    run_path.write_text(json.dumps(saved))
    agent('run', '--once')
    assert json.loads(run_path.read_text())['pending_report'] is None, 'Terminal report retry was not acknowledged'
    next((state / 'bundles').iterdir()).write_bytes(b'corrupt cached bundle')
    agent('run', '--once')
    (target / 'review/SKILL.md').write_text('local drift')
    agent('run', '--once')
    assert (target / 'review/SKILL.md').read_text() == 'initial Skill\n', 'Drift was not repaired'
    publish(alias, 'superseded Skill\n')
    publish(alias, 'updated Skill\n')
    agent('run', '--once')
    assert (target / 'review/SKILL.md').read_text() == 'updated Skill\n'
    new_alias = alias + '-new'
    agent('alias', new_alias)
    assert json.loads(agent('status').stdout)['nodeId'] == identity['nodeId']
    publish(new_alias, 'renamed Node Skill\n')
    agent('run', '--once')
    assert (target / 'review/SKILL.md').read_text() == 'renamed Node Skill\n'
    # Force the local renewal scheduler while retaining the real valid certificate.
    identity_path = state / 'credentials/identity.json'
    credential = json.loads(identity_path.read_text())
    previous_credential = credential['credentialId']
    credential['expiresAt'] = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1)).isoformat()
    identity_path.write_text(json.dumps(credential))
    agent('run', '--once')
    assert json.loads(identity_path.read_text())['credentialId'] != previous_credential, 'Certificate was not renewed'
    publish(new_alias, 'empty subscription\n', empty=True)
    agent('run', '--once')
    assert not (target / 'review').exists(), 'Removed Skill remains installed'
    assert (target / 'personal/keep.txt').read_text() == 'unmanaged'
    (target / 'review').mkdir()
    (target / 'review/SKILL.md').write_text('unowned conflict')
    publish(new_alias, 'must not overwrite\n')
    agent('run', '--once', success=False)
    assert (target / 'review/SKILL.md').read_text() == 'unowned conflict'
    rollouts = call('rollouts')['items']
    assert any(row.get('failed', 0) > 0 or row.get('state') == 'failed' for row in rollouts), 'Ownership failure was not reported'
    nodes = call('nodes')['items']
    assert any(node['nodeId'] == identity['nodeId'] and node['name'] == new_alias for node in nodes)
    call('nodes/' + identity['nodeId'] + '/revoke', {})
    agent('run', '--once', success=False)
print('Agent smoke: enrollment, real mTLS, install, update, restart, drift, alias, renewal, removal, unowned conflict, and revocation passed')
