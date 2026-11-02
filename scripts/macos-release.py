#!/usr/bin/env python3
"""Sign and notarize GitHub-built bsk on an internal Mac; verify on GitHub.

Apple credentials stay on the signing node. Shared GitHub provenance checks are
loaded from the pinned windows-release.py shipped alongside this helper.
"""
import argparse
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import tarfile
import time
from urllib.parse import urlencode
import zipfile

spec = importlib.util.spec_from_file_location('windows_release', Path(__file__).with_name('windows-release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
require, digest, save_json = release.require, release.digest, release.save_json
TARGETS = {'aarch64-apple-darwin': (0x100000c, 'arm64'), 'x86_64-apple-darwin': (0x1000007, 'x86_64')}
TEAM = '88L2Q4487U'
IDENTITY = f'Developer ID Application: Tencent Technology (Shenzhen) Company Limited ({TEAM})'
IDENTIFIER = 'com.tencent.browserskill.bsk'
KEYS = ('schema', 'repository', 'tag', 'commit', 'run_id', 'run_attempt')


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def unpack_tar(data):
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        members = archive.getmembers()
        require(len(members) == 1 and members[0].name == 'bsk' and members[0].isreg(), 'Expected only a regular bsk file')
        require(0 < members[0].size <= release.LIMIT, 'Invalid bsk size')
        return archive.extractfile(members[0]).read()


def macho(data, target):
    """Parse thin 64-bit Mach-O, excluding only the signature and its bookkeeping."""
    require(len(data) >= 32, 'Truncated Mach-O')
    header = list(struct.unpack_from('<8I', data))
    require(header[0] == 0xfeedfacf and header[1] == TARGETS[target][0] and header[3] == 2,
            f'Expected a thin {target} Mach-O executable')
    count, size = header[4:6]
    require(0 < count < 128 and 32 + size <= len(data), 'Invalid Mach-O commands')
    commands, signature, linkedit = [], None, None
    pos = 32
    for _ in range(count):
        require(pos + 8 <= 32 + size, 'Truncated load command')
        cmd, length = struct.unpack_from('<II', data, pos)
        require(length >= 8 and length % 8 == 0 and pos + length <= 32 + size, 'Invalid load command')
        value = bytearray(data[pos:pos + length])
        if cmd == 0x1d:  # LC_CODE_SIGNATURE
            require(signature is None and length == 16, 'Invalid signature command')
            signature = struct.unpack_from('<II', value, 8)
        else:
            if cmd == 0x19 and value[8:24].rstrip(b'\0') == b'__LINKEDIT':
                require(linkedit is None and length >= 72, 'Invalid __LINKEDIT')
                vmaddr, vmsize, fileoff, filesize = struct.unpack_from('<4Q', value, 24)
                require(fileoff + filesize == len(data), '__LINKEDIT must end at EOF')
                pages = (4096, 16384)  # LLVM and Apple codesign may use different page sizes.
                require(vmsize in {(filesize + page - 1) // page * page for page in pages},
                        'Unexpected __LINKEDIT VM size')
                linkedit = fileoff
                value[32:40] = b'\0' * 8  # vmsize
                value[48:56] = b'\0' * 8  # filesize
            commands.append(bytes(value))
        pos += length
    require(pos == 32 + size and linkedit is not None, 'Invalid Mach-O layout')
    end = len(data)
    if signature:
        offset, length = signature
        require(linkedit <= offset and offset % 16 == 0 and length > 0 and offset + length == len(data),
                'Invalid embedded signature range')
        end = offset
    require(pos <= linkedit <= end, 'Load commands overlap link data')
    header[4:6] = [0, 0]
    return struct.pack('<8I', *header), commands, pos, end, signature


def same_executable(unsigned, signed, target):
    old, new = macho(unsigned, target), macho(signed, target)
    require(new[4] is not None, 'Missing embedded signature')
    require(old[:2] == new[:2], 'Signing changed Mach-O header or load commands')
    start = max(old[2], new[2])
    # codesign may add LC_CODE_SIGNATURE in zero-filled header padding.
    require(unsigned[old[2]:start] == b'\0' * (start - old[2]), 'Signing overwrote header data')
    require(signed[new[2]:start] == b'\0' * (start - new[2]), 'Unexpected new header data')
    require(old[3] <= new[3] <= old[3] + 15, 'Signing changed executable payload length')
    require(unsigned[start:old[3]] == signed[start:old[3]], 'Signing changed executable code or data')
    require(signed[old[3]:new[3]] == b'\0' * (new[3] - old[3]), 'Nonzero signature alignment padding')


def source_artifacts(api, state):
    artifacts = api.pages(f'actions/runs/{state["run_id"]}/artifacts', 'artifacts')
    targets, binaries = {}, {}
    for target in TARGETS:
        name = f'bsk-{target}-{state["run_id"]}-{state["run_attempt"]}'
        matches = [a for a in artifacts if a['name'] == name]
        require(len(matches) == 1, f'Expected exactly one {name}; rerun all release build jobs')
        artifact = matches[0]
        require(artifact['workflow_run']['head_sha'] == state['commit'], 'Mac artifact commit mismatch')
        archive_name = f'bsk-v{state["tag"][5:]}-{target}.tar.gz'
        files = release.unpack_artifact(api, artifact, [archive_name])
        data = unpack_tar(files[archive_name])
        macho(data, target)
        targets[target] = {'artifact_id': artifact['id'], 'unsigned_sha256': digest(data)}
        binaries[target] = data
    return {**state, 'targets': targets}, binaries


def validate_state(api, state):
    actual = release.validate_run(api.request(f'actions/runs/{state["run_id"]}'), state['tag'],
                                  release.tag_commit(api, state['tag']), state['run_attempt'])
    require(all(state.get(k) == actual[k] for k in KEYS), 'Source build identity changed')


def prepare(args, api):
    tag = args.tag or os.environ.get('BSK_RELEASE_TAG', '')
    sha = release.tag_commit(api, tag)
    existing = api.release(tag)
    require(args.verification_only or not existing or existing['draft'], 'Version already published')
    deadline, run_id = time.monotonic() + args.timeout, args.run_id
    while True:
        if not run_id:
            runs = api.request('actions/workflows/release-cli.yml/runs?' + urlencode(
                {'head_sha': sha, 'event': 'push', 'per_page': 100}))['workflow_runs']
            matching = [r for r in runs if r['head_branch'] == tag and r['head_sha'] == sha]
            if matching:
                run_id = max(matching, key=lambda r: r['id'])['id']
        run = api.request(f'actions/runs/{run_id}') if run_id else None
        if run and run['status'] == 'completed':
            state = release.validate_run(run, tag, sha, args.attempt)
            break
        require(time.monotonic() < deadline, 'Timed out waiting for GitHub build')
        print('Waiting for GitHub release build...', flush=True)
        time.sleep(15)
    state, binaries = source_artifacts(api, state)
    state['verification_only'] = args.verification_only
    # A separate directory per source attempt preserves notary submission IDs on retry.
    work = Path('macos-signing') / f'{run_id}-{state["run_attempt"]}-{"test" if args.verification_only else "release"}'
    work.mkdir(parents=True, exist_ok=True)
    state_path = work / 'signing-state.json'
    if state_path.exists():
        require(read_json(state_path) == state, 'Existing signing workspace has different inputs')
    for target, data in binaries.items():
        path = work / 'unsigned' / target / 'bsk'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    save_json(state_path, state)
    Path('macos-workdir.txt').write_text(str(work) + '\n')
    print(json.dumps(state), flush=True)


def command(argv):
    # Never include argv in exceptions: notarytool arguments contain credentials.
    result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    require(result.returncode == 0, f'{Path(argv[0]).name} failed (exit {result.returncode}); credentials omitted')
    return result.stdout, result.stderr


def verify_signature(path, notarized=False):
    requirement = (f'anchor apple generic and certificate leaf[subject.OU] = "{TEAM}" '
                   'and certificate leaf[field.1.2.840.113635.100.6.1.13] exists')
    args = ['codesign', '--verify', '--strict', '--verbose=2', '-R=' + requirement]
    if notarized:
        args.append('--check-notarization')
    command([*args, str(path)])
    _, info = command(['codesign', '--display', '--verbose=4', str(path)])
    require(f'Authority={IDENTITY}\n' in info and f'TeamIdentifier={TEAM}\n' in info, 'Wrong Mac signing identity')
    require(f'Identifier={IDENTIFIER}\n' in info, 'Wrong Mac signing identifier')
    require(re.search(r'^Timestamp=.+$', info, re.M) and 'runtime' in info, 'Missing timestamp or hardened runtime')
    match = re.search(r'^CDHash=([0-9a-f]{40})$', info, re.M)
    require(match is not None, 'Missing CodeDirectory hash')
    # No GUI/JIT/debug exceptions are needed by the standalone Rust CLI.
    entitlements, _ = command(['codesign', '--display', '--entitlements', ':-', str(path)])
    require(not entitlements.strip(), 'Unexpected entitlements on bsk')
    return match[1]


def check_notary_log(log, submission, targets):
    require(log.get('jobId') == submission and log.get('status') == 'Accepted' and log.get('statusCode') == 0,
            'Notarization was not accepted for this submission')
    for target, (_, arch) in TARGETS.items():
        matches = [ticket for ticket in log.get('ticketContents', [])
                   if ticket.get('arch') == arch and ticket.get('cdhash') == targets[target]['cdhash']
                   and ticket.get('path', '').endswith(f'/{target}/bsk')]
        require(len(matches) == 1, f'Notary ticket does not cover {target}')


def sign(args):
    state = read_json('signing-state.json')
    auth = []
    for name, flag in [('APPLE_ID', '--apple-id'), ('APPLE_PASSWORD', '--password'), ('APPLE_TEAM_ID', '--team-id')]:
        value = os.environ.get(name, '')
        require(value and not value.startswith('${'), f'{name} was not resolved from BK credentials')
        if name == 'APPLE_TEAM_ID':
            require(value == TEAM, 'Unexpected Apple team')
        auth.extend([flag, value])
    targets = {}
    saved = read_json('notary-submission.json') if Path('notary-submission.json').exists() else None
    for target, metadata in state['targets'].items():
        original = Path('unsigned', target, 'bsk').read_bytes()
        require(digest(original) == metadata['unsigned_sha256'], 'Signing input changed')
        path = Path('signed', target, 'bsk')
        if not saved:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(original)
            path.chmod(0o755)
            command(['codesign', '--force', '--sign', IDENTITY, '--identifier', IDENTIFIER,
                     '--options', 'runtime', '--timestamp', str(path)])
        signed = path.read_bytes()
        same_executable(original, signed, target)
        targets[target] = {**metadata, 'signed_sha256': digest(signed), 'cdhash': verify_signature(path)}
    if not saved:
        with zipfile.ZipFile('notarization.zip', 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for target in TARGETS:
                archive.write(Path('signed', target, 'bsk'), f'{target}/bsk')
        response, _ = command(['xcrun', 'notarytool', 'submit', 'notarization.zip', *auth, '--output-format', 'json'])
        submission = json.loads(response)['id']
        require(re.fullmatch(r'[0-9a-f-]{36}', submission), 'Invalid notary submission ID')
        saved = {'id': submission, 'targets': targets}
        save_json('notary-submission.json', saved)
    require(saved['targets'] == targets, 'Signed files changed after notary submission')
    submission = saved['id']
    print(f'Notary submission: {submission}', flush=True)
    deadline = time.monotonic() + args.timeout
    while True:
        response, _ = command(['xcrun', 'notarytool', 'info', submission, *auth, '--output-format', 'json'])
        status = json.loads(response)['status']
        print(f'Notary status: {status}', flush=True)
        if status != 'In Progress':
            break
        require(time.monotonic() < deadline, f'Notarization still pending; rerun to resume {submission}')
        time.sleep(20)
    command(['xcrun', 'notarytool', 'log', submission, *auth, 'notary-log.json'])
    log = read_json('notary-log.json')
    check_notary_log(log, submission, targets)
    for target in TARGETS:
        verify_signature(Path('signed', target, 'bsk'), notarized=True)
    manifest = {**state, 'targets': targets, 'submission_id': submission, 'notary_status': 'Accepted'}
    if Path('macos-signing.json').exists():
        # The remote completion marker may already exist even if its upload response
        # was lost. Preserve the exact ZIP bytes, including filesystem metadata.
        completed = read_json('macos-signing.json')
        require(completed == {**manifest, 'bundle_sha256': completed.get('bundle_sha256')},
                'Completed Mac handoff no longer matches the verified signing result')
        files = validate_bundle(state, completed, Path('signed-macos.zip').read_bytes())
        Path('notary-log.json').write_bytes(files['notary-log.json'])
    else:
        with zipfile.ZipFile('signed-macos.zip', 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for target in TARGETS:
                archive.write(Path('signed', target, 'bsk'), f'{target}/bsk')
            archive.write('notary-log.json')
        manifest['bundle_sha256'] = digest(Path('signed-macos.zip').read_bytes())
        save_json('macos-signing.json', manifest)
    print('Both Mac executables passed signature, content and online notarization checks.', flush=True)


def asset_names(state):
    base = f'bsk-macos-signed-{state["run_id"]}-{state["run_attempt"]}'
    return base + '.zip', base + '.json'


def return_signed(args, api):
    state = read_json('signing-state.json')
    require(state.get('verification_only') is False, 'Verification-only builds cannot upload to GitHub')
    validate_state(api, state)
    manifest = read_json('macos-signing.json')
    bundle = Path('signed-macos.zip').read_bytes()
    validate_bundle(state, manifest, bundle)
    # Windows owns draft creation; waiting avoids a create-draft race with its pinned helper.
    deadline = time.monotonic() + args.timeout
    while True:
        draft = api.release(state['tag'])
        require(not draft or draft['draft'], 'Refusing to modify a published release')
        assets = {a['name']: a for a in api.assets(draft)} if draft else {}
        if release.asset_names(state)[1] in assets:
            break
        require(time.monotonic() < deadline, 'Waiting for Windows signing draft timed out; retry after Windows succeeds')
        print('Waiting for Windows signing draft...', flush=True)
        time.sleep(15)
    validate_state(api, state)
    zip_name, json_name = asset_names(state)
    if json_name in assets:
        existing = json.loads(api.request(f'releases/assets/{assets[json_name]["id"]}', binary=True, accept='application/octet-stream'))
        require(existing == manifest, 'A different Mac handoff already exists; do not overwrite it')
        print('Mac signing handoff already complete.')
        return
    api.upload(draft, zip_name, bundle)
    api.upload(draft, json_name, (json.dumps(manifest, indent=2) + '\n').encode())
    print(f'Mac signing result staged in draft {draft["id"]}', flush=True)


def validate_bundle(state, manifest, bundle):
    require(all(state.get(k) == manifest.get(k) for k in KEYS), 'Mac signing result belongs to another build')
    require(manifest.get('verification_only') == state.get('verification_only', False), 'Wrong signing mode')
    require(manifest.get('notary_status') == 'Accepted', 'Mac signing result is not notarized')
    require(digest(bundle) == manifest.get('bundle_sha256'), 'Signed Mac bundle hash mismatch')
    expected = [f'{t}/bsk' for t in TARGETS] + ['notary-log.json']
    with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
        require(sorted(archive.namelist()) == sorted(expected), 'Unexpected signed Mac bundle contents')
        require(all(i.file_size <= release.LIMIT for i in archive.infolist()), 'Oversized signed Mac member')
        files = {name: archive.read(name) for name in expected}
    require(set(manifest['targets']) == set(TARGETS), 'Missing Mac architecture')
    for target in TARGETS:
        metadata = manifest['targets'][target]
        require(all(metadata.get(k) == v for k, v in state['targets'][target].items()), 'Mac source artifact mismatch')
        require(digest(files[f'{target}/bsk']) == metadata.get('signed_sha256'), 'Signed Mac executable hash mismatch')
    check_notary_log(json.loads(files['notary-log.json']), manifest['submission_id'], manifest['targets'])
    return files


def collect(args, api):
    run = api.request(f'actions/runs/{args.run_id}')
    state = release.validate_run(run, run['head_branch'], release.tag_commit(api, run['head_branch']), args.attempt)
    state, originals = source_artifacts(api, state)
    zip_name, json_name = asset_names(state)
    deadline = time.monotonic() + args.timeout
    while True:
        draft = api.release(state['tag'])
        require(not draft or draft['draft'], 'Version already published')
        assets = {a['name']: a for a in api.assets(draft)} if draft else {}
        if zip_name in assets and json_name in assets:
            break
        require(time.monotonic() < deadline, 'Timed out waiting for Mac signing; release remains unpublished')
        print('Waiting for internal Mac signing and notarization...', flush=True)
        time.sleep(15)
    manifest = json.loads(api.request(f'releases/assets/{assets[json_name]["id"]}', binary=True, accept='application/octet-stream'))
    bundle = api.request(f'releases/assets/{assets[zip_name]["id"]}', binary=True, accept='application/octet-stream')
    files = validate_bundle(state, manifest, bundle)
    Path('dist').mkdir(exist_ok=True)
    for target in TARGETS:
        data = files[f'{target}/bsk']
        same_executable(originals[target], data, target)
        path = Path('signed', target, 'bsk')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        path.chmod(0o755)
        require(verify_signature(path, notarized=True) == manifest['targets'][target]['cdhash'], 'CDHash mismatch')
        with tarfile.open(Path('dist', f'bsk-v{state["tag"][5:]}-{target}.tar.gz'), 'w:gz') as archive:
            archive.add(path, arcname='bsk')
    validate_state(api, state)
    save_json('macos-release-state.json', {**manifest, 'release_id': draft['id']})
    print('Mac release packages verified independently on the GitHub runner.', flush=True)


def check_final(windows_state):
    mac = read_json('macos-release-state.json')
    require(all(mac.get(k) == windows_state.get(k) for k in (*KEYS, 'release_id')), 'Platform results belong to different builds')
    require(mac.get('verification_only') is False and mac.get('notary_status') == 'Accepted', 'Mac verification is incomplete')
    require(set(mac['targets']) == set(TARGETS), 'Missing verified Mac architecture')
    for target in TARGETS:
        data = unpack_tar(Path('dist', f'bsk-v{mac["tag"][5:]}-{target}.tar.gz').read_bytes())
        require(digest(data) == mac['targets'][target]['signed_sha256'], 'Mac executable changed after verification')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['prepare', 'sign', 'return-signed', 'collect'])
    parser.add_argument('--tag')
    parser.add_argument('--run-id', type=int)
    parser.add_argument('--attempt', type=int)
    parser.add_argument('--timeout', type=int, default=3600)
    parser.add_argument('--verification-only', action='store_true')
    args = parser.parse_args()
    if args.command == 'sign':
        sign(args)
    else:
        {'prepare': prepare, 'return-signed': return_signed, 'collect': collect}[args.command](args, release.GitHub())


if __name__ == '__main__':
    main()
