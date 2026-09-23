#!/usr/bin/env python3
"""Verify scheduled CLIProxy discovery through a real Server and Agent in a disposable stack."""
import argparse
import json
from pathlib import Path
import shlex
import shutil
import socket
import ssl
import subprocess
import tempfile
import time
import tomllib
import urllib.request
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--image', required=True, help='Locally built Fleet Server image')
parser.add_argument('--agent', required=True, type=Path, help='Locally built fleet-agent binary')
args = parser.parse_args()
agent_binary = args.agent.resolve()
repo = Path(__file__).resolve().parents[1]


def run(*command, **kwargs):
    return subprocess.run(command, check=True, text=True, capture_output=True, **kwargs).stdout.strip()


def wait_for(check, description, timeout=90):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(1)
    raise AssertionError('Timed out: ' + description)


with tempfile.TemporaryDirectory(prefix='fleet-cliproxy-sync-') as temporary:
    root = Path(temporary)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    run('python3', str(repo / 'deploy/homelab/setup.py'), '--host', 'proxy', '--port', str(port), '--directory', str(root))
    shutil.copy(repo / 'deploy/homelab/compose.yaml', root / 'compose.yaml')
    with (root / '.env').open('a') as output:
        output.write(f'\nFLEET_IMAGE={args.image}\nFLEET_PUBLIC_URL=https://localhost:{port}\nFLEET_SOURCE_REMOTE=/var/lib/fleet/test-source\nFLEET_CLIPROXY_API_KEY=smoke-proxy-key\n')
    (root / 'compose.override.yaml').write_text('''services:
  server:
    environment:
      SSL_CERT_FILE: /run/fleet/tls/ca.pem
      Fleet__CliProxySyncIntervalSeconds: "10"
      Source__PollIntervalSeconds: "3600"
    depends_on:
      proxy: {condition: service_started}
  proxy:
    image: python:3.12-alpine
    command: [python3, /fixture/proxy.py]
    volumes:
      - .:/fixture
    networks: [outbound]
''')
    (root / 'proxy.py').write_text('''import http.server, pathlib, ssl
root = pathlib.Path('/fixture')
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.headers.get('Authorization') != 'Bearer smoke-proxy-key':
            self.send_error(401); return
        if self.path != '/v1/models?client_version=0.154.0':
            self.send_error(404); return
        count = root / 'requests'
        count.write_text(str(int(count.read_text()) + 1) if count.exists() else '1')
        body = (root / 'catalog.json').read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers(); self.wfile.write(body)
    def log_message(self, *args): pass
server = http.server.HTTPServer(('0.0.0.0', 8443), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(root / 'secrets/tls/server.pem', root / 'secrets/tls/server.key')
server.socket = context.wrap_socket(server.socket, server_side=True)
server.serve_forever()
''')

    def catalog(model, efforts):
        path = root / 'catalog.next'
        path.write_text(json.dumps({'models': [{'slug': model, 'supported_reasoning_levels': [{'effort': effort} for effort in efforts]}]}))
        path.replace(root / 'catalog.json')

    def requests():
        path = root / 'requests'
        return int(path.read_text() or '0') if path.exists() else 0

    catalog('model-one', ['low', 'high'])
    operator_env = {}
    for line in (root / 'operator.env').read_text().splitlines():
        name, value = line.removeprefix('export ').split('=', 1)
        operator_env[name] = shlex.split(value)[0]
    context = ssl.create_default_context(cafile=root / 'secrets/tls/ca.pem')

    def api(path, body=None):
        request = urllib.request.Request(f'https://localhost:{port}/operator/v1/' + path,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Authorization': 'Bearer ' + operator_env['FLEET_OPERATOR_TOKEN'], 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, context=context, timeout=30) as response:
            return json.load(response)

    compose = ['docker', 'compose', '--project-name', 'fleet-model-smoke-' + uuid.uuid4().hex[:8], '--project-directory', str(root)]
    try:
        run(*compose, 'up', '-d', '--wait', '--wait-timeout', '180')
        assert requests() == 0, 'Unconfigured server fetched models'
        source = root / 'source'
        source.mkdir()
        run('git', '-C', str(source), 'init', '-b', 'main')
        run('git', '-C', str(source), 'config', 'user.email', 'smoke@example.invalid')
        run('git', '-C', str(source), 'config', 'user.name', 'Fleet smoke')
        home = root / 'home'
        home.mkdir(mode=0o700)
        state = root / 'state'
        token = root / 'enrollment.json'
        token.write_text(json.dumps(api('enrollment-tokens', {'expiresInSeconds': 900})))
        token.chmod(0o600)

        def agent(*arguments):
            return run(str(agent_binary), '--state-dir', str(state), *arguments, timeout=90)

        agent('enroll', '--server-url', f'https://localhost:{port}', '--ca-cert', str(root / 'secrets/tls/ca.pem'),
              '--alias', 'model-smoke', '--home', str(home), '--token-file', str(token))
        config = home / '.config/opencode/opencode.jsonc'
        config.parent.mkdir(parents=True)
        original = '// Keep this comment\n{"theme":"system"}\n'
        config.write_text(original)
        (home / '.codex').mkdir()
        (home / '.codex/auth.json').write_text('{"fixture":"untouched"}')

        def publish(mode):
            (source / 'fleet.yml').write_text(f'''schema: fleet/v2
cliproxy:
  base-url: https://proxy:8443/v1
targets:
  skills:
    base: home
    path: .agents/skills
nodes:
  model-smoke:
    targets:
      skills:
        groups: []
      ai-clients:
        codex:
          mode: {mode}
        opencode:
          mode: {mode}
''')
            run('git', '-C', str(source), 'add', '.')
            run('git', '-C', str(source), 'commit', '-m', mode)
            container = run(*compose, 'ps', '-q', 'server')
            run('docker', 'exec', container, 'mkdir', '-p', '/var/lib/fleet/test-source')
            archive = subprocess.run(['tar', '-C', str(source), '-cf', '-', '.'], check=True, capture_output=True).stdout
            subprocess.run(['docker', 'exec', '-i', container, 'tar', '-C', '/var/lib/fleet/test-source', '--no-same-owner', '-xf', '-'], input=archive, check=True, capture_output=True)
            result = api('source/rescan', {})
            assert result['outcome'] == 'accepted', result

        def check_clients(model, efforts):
            codex = tomllib.loads((home / '.codex/config.toml').read_text())
            models = json.loads(Path(codex['model_catalog_json']).read_text())['models']
            assert [entry['slug'] for entry in models] == [model]
            assert [entry['effort'] for entry in models[0]['supported_reasoning_levels']] == efforts
            text = config.read_text()
            assert '// Keep this comment' in text
            opencode = json.loads('\n'.join(line for line in text.splitlines() if not line.strip().startswith('//')))
            entries = opencode['provider']['fleet-cliproxy']['models']
            assert list(entries) == [model]
            assert list(entries[model]['variants']) == efforts
            assert opencode['model'] == 'fleet-cliproxy/' + model
            assert not (config.parent / 'opencode.json').exists(), 'Wrote lower-priority OpenCode configuration'
            assert json.loads((home / '.codex/auth.json').read_text()) == {'fixture': 'untouched'}

        (root / 'catalog.json').write_text('{"models":[]}')
        publish('cliproxy')
        wait_for(lambda: requests() >= 1, 'initial discovery without an Agent model request')
        failed = subprocess.run([str(agent_binary), '--state-dir', str(state), 'run', '--once'], capture_output=True, text=True, timeout=90)
        assert failed.returncode != 0, 'Initial unavailable catalog unexpectedly succeeded'
        catalog('model-one', ['low', 'high'])
        api('cliproxy/refresh', {})
        def recovered():
            result = subprocess.run([str(agent_binary), '--state-dir', str(state), 'run', '--once'], capture_output=True, text=True, timeout=90)
            if result.returncode != 0:
                return False
            return (home / '.codex/config.toml').exists() and 'fleet-cliproxy' in config.read_text()
        wait_for(recovered, 'failed initial assignment retries without a source commit', timeout=100)
        check_clients('model-one', ['low', 'high'])
        revision = run('git', '-C', str(source), 'rev-parse', 'HEAD')
        assignments = api('desired-revisions')
        count = requests()
        catalog('model-two', ['medium', 'xhigh'])
        wait_for(lambda: requests() > count, 'scheduled discovery while Agent is stopped')
        agent('run', '--once')
        check_clients('model-two', ['medium', 'xhigh'])
        assert api('desired-revisions') == assignments, 'Model refresh published a repository revision'
        assert run('git', '-C', str(source), 'rev-parse', 'HEAD') == revision
        catalog('model-three', ['high'])
        api('cliproxy/refresh', {})
        agent('run', '--once')
        check_clients('model-three', ['high'])
        (root / 'catalog.json').write_text('{"models":[]}')
        api('cliproxy/refresh', {})
        agent('run', '--once')
        check_clients('model-three', ['high'])
        publish('native')
        agent('run', '--once')
        restored = config.read_text()
        assert '// Keep this comment' in restored
        assert json.loads('\n'.join(line for line in restored.splitlines() if not line.strip().startswith('//'))) == {'theme': 'system'}, 'Native mode did not restore the original OpenCode settings'
        print('CLIProxy smoke passed: initial failure recovery, scheduled and manual discovery; unchanged repository; real Agent Codex/OpenCode JSONC updates; outage retention; native restoration.')
    finally:
        run(*compose, 'down', '--volumes', '--remove-orphans')
