#!/usr/bin/env python3
"""Exchange immutable CLI build artifacts with the Windows signing pipeline.

Uses only the standard library. GH_TOKEN is supplied by the CI credential store.
No private key or signing-service credential leaves the internal signing job.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import struct
import time
from urllib.error import HTTPError
from urllib.parse import quote, urlencode, urlparse
from urllib.request import Request, HTTPRedirectHandler, build_opener
import zipfile

REPO = 'Tencent/BrowserSkill'
WORKFLOW = '.github/workflows/release-cli.yml'
TAG = re.compile(r'cli-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?\Z')
SHA = re.compile(r'[0-9a-f]{40}\Z')
TARGETS = ('aarch64-apple-darwin', 'x86_64-apple-darwin',
           'x86_64-unknown-linux-musl', 'aarch64-unknown-linux-musl')
LIMIT = 96 * 1024 * 1024


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


class SafeRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        require(urlparse(newurl).scheme == 'https', 'Non-HTTPS download redirect')
        target = super().redirect_request(req, fp, code, msg, headers, newurl)
        if urlparse(req.full_url).netloc != urlparse(newurl).netloc:
            target.remove_header('Authorization')
        return target


class GitHub:
    def __init__(self):
        self.token = os.environ.get('GH_TOKEN', '')
        require(self.token and not self.token.startswith('${'), 'GH_TOKEN was not resolved from the CI credential store')
        self.opener = build_opener(SafeRedirect())

    def request(self, path, method='GET', data=None, binary=False, accept=None):
        url = path if path.startswith('https://') else f'https://api.github.com/repos/{REPO}' + (f'/{path}' if path else '')
        require(urlparse(url).hostname in ('api.github.com', 'uploads.github.com'), 'Unexpected GitHub API host')
        headers = {'Authorization': f'Bearer {self.token}', 'User-Agent': 'BrowserSkill-release',
                   'Accept': accept or 'application/vnd.github+json',
                   'X-GitHub-Api-Version': '2022-11-28'}
        if isinstance(data, dict):
            data = json.dumps(data).encode()
            headers['Content-Type'] = 'application/json'
        elif data is not None:
            headers['Content-Type'] = 'application/octet-stream'
        request = Request(url, data=data, headers=headers, method=method)
        # Retry read-only transient failures. Never blindly repeat a mutation.
        for attempt in range(4):
            try:
                with self.opener.open(request, timeout=90) as response:
                    body = response.read(LIMIT + 1)
                require(len(body) <= LIMIT, 'GitHub response exceeded size limit')
                return body if binary else (json.loads(body) if body else None)
            except HTTPError as error:
                if method != 'GET' or error.code not in (429, 500, 502, 503, 504) or attempt == 3:
                    raise
                time.sleep(2 ** attempt)

    def optional(self, path):
        try:
            return self.request(path)
        except HTTPError as error:
            if error.code == 404:
                return None
            raise

    def pages(self, path, key=None):
        items = []
        for page in range(1, 11):
            response = self.request(f'{path}{"&" if "?" in path else "?"}per_page=100&page={page}')
            batch = response[key] if key else response
            items.extend(batch)
            if len(batch) < 100:
                return items
        raise ValueError('GitHub pagination limit exceeded')

    def release(self, tag):
        # Drafts require Contents: write, including when using GITHUB_TOKEN.
        return next((r for r in self.pages('releases') if r['tag_name'] == tag), None)

    def assets(self, release):
        return self.pages(f'releases/{release["id"]}/assets')

    def upload(self, release, name, data):
        require(self.request(f'releases/{release["id"]}')['draft'], 'Refusing to alter a published release')
        for asset in self.assets(release):
            if asset['name'] == name:
                if asset.get('digest') == f'sha256:{digest(data)}':
                    return asset
                self.request(f'releases/assets/{asset["id"]}', method='DELETE')
        url = release['upload_url'].split('{')[0] + '?' + urlencode({'name': name})
        return self.request(url, method='POST', data=data)


def tag_commit(api, tag):
    require(TAG.fullmatch(tag), 'Expected a cli-v<semver> release tag')
    obj = api.request(f'git/ref/tags/{quote(tag, safe="")}')['object']
    for _ in range(5):
        if obj['type'] == 'commit':
            break
        require(obj['type'] == 'tag', 'Unexpected tag object type')
        obj = api.request(f'git/tags/{obj["sha"]}')['object']
    require(obj['type'] == 'commit' and SHA.fullmatch(obj['sha']), 'Tag did not resolve to a commit')
    sha = obj['sha']
    default = api.request('')['default_branch']
    comparison = api.request(f'compare/{sha}...{quote(default, safe="")}')
    require(comparison['status'] in ('ahead', 'identical'), 'Release tag must be reachable from the default branch')
    return sha


def validate_run(run, tag, sha, attempt=None):
    require(run['head_repository']['full_name'] == REPO, 'Build came from another repository')
    require(run['path'] == WORKFLOW, 'Unexpected source workflow')
    require(run['event'] in ('push', 'workflow_dispatch'), 'Only release tag builds may be signed')
    require(run['head_branch'] == tag and run['head_sha'] == sha, 'Build does not match the release tag')
    if attempt is not None:
        require(run['run_attempt'] == attempt, 'Source run was rerun; refusing stale artifacts')
    require(run['status'] == 'completed' and run['conclusion'] == 'success', 'Source build is not successful')
    return {'schema': 1, 'repository': REPO, 'tag': tag, 'commit': sha,
            'run_id': run['id'], 'run_attempt': run['run_attempt']}


def unpack_artifact(api, artifact, expected):
    require(not artifact['expired'], 'Build artifact has expired; rerun the full build')
    data = api.request(f'actions/artifacts/{artifact["id"]}/zip', binary=True)
    expected_digest = artifact.get('digest')
    require(expected_digest == f'sha256:{digest(data)}', 'Artifact archive SHA256 mismatch or missing digest')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        require(sorted(archive.namelist()) == sorted(expected), 'Unexpected files in build artifact')
        require(all(info.file_size <= LIMIT for info in archive.infolist()), 'Artifact member exceeds size limit')
        return {name: archive.read(name) for name in expected}


def source_artifacts(api, state):
    artifacts = api.pages(f'actions/runs/{state["run_id"]}/artifacts', 'artifacts')
    name = f'bsk-windows-unsigned-{state["run_id"]}-{state["run_attempt"]}'
    matches = [a for a in artifacts if a['name'] == name]
    require(len(matches) == 1, f'Expected exactly one {name} artifact')
    artifact = matches[0]
    require(artifact['workflow_run']['head_sha'] == state['commit'], 'Artifact commit mismatch')
    files = unpack_artifact(api, artifact, ['bsk.exe', 'request.json'])
    request = json.loads(files['request.json'])
    for key, value in state.items():
        require(request.get(key) == value, f'Build request {key} mismatch')
    require(request.get('ref') == f'refs/tags/{state["tag"]}', 'Build was not run on a tag')
    unsigned_sha = digest(files['bsk.exe'])
    require(request.get('unsigned_sha256') == unsigned_sha, 'Unsigned binary SHA256 mismatch')
    return {**state, 'artifact_id': artifact['id'], 'unsigned_sha256': unsigned_sha}, files['bsk.exe'], artifacts


def same_executable(unsigned, signed):
    require(unsigned[:2] == signed[:2] == b'MZ', 'Expected Windows executable')
    pe = struct.unpack_from('<I', unsigned, 0x3c)[0]
    optional = pe + 24
    require(unsigned[pe:pe+4] == signed[pe:pe+4] == b'PE\0\0', 'Invalid PE header')
    require(struct.unpack_from('<H', unsigned, optional)[0] == 0x20b, 'Expected PE32+ executable')
    security = optional + 112 + 8 * 4
    require(struct.unpack_from('<II', unsigned, security) == (0, 0), 'Input executable was already signed')
    offset, size = struct.unpack_from('<II', signed, security)
    require(offset >= len(unsigned) and offset % 8 == 0 and size > 8 and offset + size == len(signed),
            'Invalid Authenticode certificate table')
    require(signed[len(unsigned):offset] == b'\0' * (offset - len(unsigned)), 'Unexpected data before signature')
    original, result = bytearray(unsigned), bytearray(signed[:len(unsigned)])
    for start, length in [(optional + 64, 4), (security, 8)]:
        original[start:start+length] = result[start:start+length] = b'\0' * length
    require(original == result, 'Signing changed executable code or data')


def asset_names(state):
    base = f'bsk-windows-signed-{state["run_id"]}-{state["run_attempt"]}'
    return base + '.exe', base + '.json'


def save_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')


def output(name, value):
    print(f'{name}={value}', flush=True)
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as stream:
            stream.write(f'{name}={value}\n')


def make_request(args):
    tag = os.environ['GITHUB_REF_NAME']
    require(TAG.fullmatch(tag) and os.environ['GITHUB_REF'] == f'refs/tags/{tag}', 'Run release builds on a CLI tag')
    require(os.environ['GITHUB_REPOSITORY'] == REPO, 'Unexpected repository')
    data = Path(args.binary).read_bytes()
    save_json(args.out, {'schema': 1, 'repository': REPO, 'tag': tag,
                        'commit': os.environ['GITHUB_SHA'], 'ref': os.environ['GITHUB_REF'],
                        'run_id': int(os.environ['GITHUB_RUN_ID']), 'run_attempt': int(os.environ['GITHUB_RUN_ATTEMPT']),
                        'unsigned_sha256': digest(data)})


def prepare(args, api):
    tag = args.tag or os.environ.get('BSK_RELEASE_TAG', '')
    sha = tag_commit(api, tag)
    release = api.release(tag)
    require(not release or release['draft'], 'This version is already published; use a new release tag')
    deadline = time.monotonic() + args.timeout
    run_id = args.run_id
    while True:
        if not run_id:
            runs = api.request('actions/workflows/release-cli.yml/runs?' + urlencode({'head_sha': sha, 'event': 'push', 'per_page': 100}))['workflow_runs']
            matching = [r for r in runs if r['head_branch'] == tag and r['head_sha'] == sha]
            if matching:
                run_id = max(matching, key=lambda r: r['id'])['id']
        run = api.request(f'actions/runs/{run_id}') if run_id else None
        if run and run['status'] == 'completed':
            state = validate_run(run, tag, sha, args.attempt)
            break
        require(time.monotonic() < deadline, 'Timed out waiting for the GitHub release build')
        print('Waiting for GitHub release build...', flush=True)
        time.sleep(15)
    state, binary, _ = source_artifacts(api, state)
    Path('unsigned').mkdir(exist_ok=True)
    Path('signed').mkdir(exist_ok=True)
    Path('unsigned/bsk.exe').write_bytes(binary)
    save_json('signing-state.json', state)
    print(json.dumps(state), flush=True)


def return_signed(args, api):
    state = json.loads(Path('signing-state.json').read_text())
    validate_run(api.request(f'actions/runs/{state["run_id"]}'), state['tag'], tag_commit(api, state['tag']), state['run_attempt'])
    unsigned, signed = Path('unsigned/bsk.exe').read_bytes(), Path('signed/bsk.exe').read_bytes()
    require(digest(unsigned) == state['unsigned_sha256'], 'Signing input changed')
    same_executable(unsigned, signed)
    release = api.release(state['tag'])
    if not release:
        release = api.request('releases', method='POST', data={'tag_name': state['tag'], 'target_commitish': state['commit'],
                                                            'name': f'bsk CLI {state["tag"][5:]}', 'draft': True})
    require(release['draft'], 'Refusing to modify a published release')
    exe_name, json_name = asset_names(state)
    # The manifest is the completion marker. Never change an already completed handoff.
    existing = next((a for a in api.assets(release) if a['name'] == json_name), None)
    if existing:
        manifest = json.loads(api.request(f'releases/assets/{existing["id"]}', binary=True, accept='application/octet-stream'))
        require(all(manifest.get(k) == v for k, v in state.items()), 'Existing signing handoff belongs to another build')
        print('Signing handoff already exists; rerun the GitHub publish workflow if needed.')
        return
    api.upload(release, exe_name, signed)
    manifest = {**state, 'signed_sha256': digest(signed)}
    api.upload(release, json_name, (json.dumps(manifest, indent=2) + '\n').encode())
    save_json('signed/signing.json', manifest)
    print(f'Signed result staged in draft release {release["id"]}', flush=True)


def collect(args, api):
    run = api.request(f'actions/runs/{args.run_id}')
    tag = run['head_branch']
    state = validate_run(run, tag, tag_commit(api, tag), args.attempt)
    state, unsigned, artifacts = source_artifacts(api, state)
    exe_name, json_name = asset_names(state)
    deadline = time.monotonic() + args.timeout
    while True:
        release = api.release(tag)
        require(not release or release['draft'], 'Release has already been published')
        assets = {a['name']: a for a in api.assets(release)} if release else {}
        if exe_name in assets and json_name in assets:
            break
        require(time.monotonic() < deadline, 'Timed out waiting for the internal signing pipeline; no release was published')
        print('Waiting for the internal Windows signing result...', flush=True)
        time.sleep(15)
    manifest = json.loads(api.request(f'releases/assets/{assets[json_name]["id"]}', binary=True, accept='application/octet-stream'))
    for key, value in state.items():
        require(manifest.get(key) == value, f'Signing result {key} mismatch')
    signed = api.request(f'releases/assets/{assets[exe_name]["id"]}', binary=True, accept='application/octet-stream')
    require(digest(signed) == manifest.get('signed_sha256'), 'Signed executable SHA256 mismatch')
    same_executable(unsigned, signed)
    Path('signed').mkdir(exist_ok=True)
    Path('dist').mkdir(exist_ok=True)
    Path('signed/bsk.exe').write_bytes(signed)
    for target in TARGETS:
        artifact_name = f'bsk-{target}-{state["run_id"]}-{state["run_attempt"]}'
        matches = [a for a in artifacts if a['name'] == artifact_name]
        require(len(matches) == 1, f'Missing {artifact_name}; rerun all build jobs, not only failed jobs')
        archive_name = f'bsk-v{tag[5:]}-{target}.tar.gz'
        files = unpack_artifact(api, matches[0], [archive_name])
        Path('dist', archive_name).write_bytes(files[archive_name])
    save_json('release-state.json', {**manifest, 'release_id': release['id']})
    output('version', tag[5:])
    output('tag', tag)
    output('signed_sha256', digest(signed))


def publish(args, api):
    state = json.loads(Path('release-state.json').read_text())
    validate_run(api.request(f'actions/runs/{state["run_id"]}'), state['tag'], tag_commit(api, state['tag']), state['run_attempt'])
    release = api.request(f'releases/{state["release_id"]}')
    require(release['draft'] and release['tag_name'] == state['tag'], 'Release is no longer the expected draft')
    version = state['tag'][5:]
    names = [f'bsk-v{version}-{t}.tar.gz' for t in TARGETS] + [f'bsk-v{version}-x86_64-pc-windows-msvc.zip', 'version.json']
    require(sorted(p.name for p in Path('dist').iterdir()) == sorted(names), 'Unexpected final release files')
    with zipfile.ZipFile(Path('dist', names[-2])) as archive:
        require(archive.namelist() == ['bsk.exe'], 'Unexpected Windows package contents')
        require(digest(archive.read('bsk.exe')) == state['signed_sha256'], 'Verified Windows executable was changed during packaging')
    for name in names:
        api.upload(release, name, Path('dist', name).read_bytes())
    # Remove only this protocol's staging assets before making the release visible.
    for asset in api.assets(release):
        if re.fullmatch(r'bsk-windows-signed-\d+-\d+\.(exe|json)', asset['name']):
            api.request(f'releases/assets/{asset["id"]}', method='DELETE')
    update = {'draft': False, 'prerelease': '-' in version, 'make_latest': 'false' if '-' in version else 'true'}
    if not release.get('body'):
        update['body'] = api.request('releases/generate-notes', method='POST',
                                     data={'tag_name': state['tag'], 'target_commitish': state['commit']})['body']
    api.request(f'releases/{release["id"]}', method='PATCH', data=update)
    print(f'https://github.com/{REPO}/releases/tag/{state["tag"]}', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['request', 'prepare', 'return-signed', 'collect', 'publish'])
    parser.add_argument('--tag')
    parser.add_argument('--run-id', type=int)
    parser.add_argument('--attempt', type=int)
    parser.add_argument('--timeout', type=int, default=1800)
    parser.add_argument('--binary', default='unsigned/bsk.exe')
    parser.add_argument('--out', default='unsigned/request.json')
    args = parser.parse_args()
    if args.command == 'request':
        make_request(args)
        return
    api = GitHub()
    {'prepare': prepare, 'return-signed': return_signed, 'collect': collect, 'publish': publish}[args.command](args, api)


if __name__ == '__main__':
    main()
