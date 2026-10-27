import importlib.util
import io
import json
from pathlib import Path
import struct
import unittest
from unittest.mock import patch, MagicMock
from urllib.request import Request
import zipfile

spec = importlib.util.spec_from_file_location('release', Path(__file__).with_name('windows-release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def run_record(self, **changes):
        return dict({'id': 123, 'run_attempt': 2, 'head_repository': {'full_name': release.REPO},
                     'path': release.WORKFLOW, 'head_sha': 'a' * 40, 'head_branch': 'cli-v1.2.3',
                     'event': 'push', 'status': 'completed', 'conclusion': 'success'}, **changes)

    def test_artifact_and_release_downloads_use_their_required_media_types(self):
        with patch.dict('os.environ', {'GH_TOKEN': 'test'}):
            api = release.GitHub()
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'binary'
        api.opener = MagicMock()
        api.opener.open.return_value = response
        api.request('actions/artifacts/1/zip', binary=True)
        self.assertEqual(api.opener.open.call_args.args[0].get_header('Accept'), 'application/vnd.github+json')
        api.request('releases/assets/1', binary=True, accept='application/octet-stream')
        self.assertEqual(api.opener.open.call_args.args[0].get_header('Accept'), 'application/octet-stream')

    def test_repository_metadata_url_has_no_trailing_slash(self):
        with patch.dict('os.environ', {'GH_TOKEN': 'test'}):
            api = release.GitHub()
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'{"default_branch":"main"}'
        api.opener = MagicMock()
        api.opener.open.return_value = response
        self.assertEqual(api.request('')['default_branch'], 'main')
        self.assertEqual(api.opener.open.call_args.args[0].full_url, 'https://api.github.com/repos/Tencent/BrowserSkill')

    def test_source_identity_and_success_are_required(self):
        release.validate_run(self.run_record(), 'cli-v1.2.3', 'a' * 40, 2)
        invalid = [dict(head_repository={'full_name': 'attacker/BrowserSkill'}), dict(path='.github/workflows/ci.yml'),
                   dict(head_sha='b' * 40), dict(head_branch='main'), dict(event='pull_request'),
                   dict(conclusion='failure'), dict(status='in_progress'), dict(run_attempt=3)]
        for changes in invalid:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                release.validate_run(self.run_record(**changes), 'cli-v1.2.3', 'a' * 40, 2)

    def test_release_tag_validation(self):
        for tag in ['cli-v1.2.3', 'cli-v0.4.0-rc.1']:
            self.assertIsNotNone(release.TAG.fullmatch(tag))
        for tag in ['main', 'cli-v1.2', 'cli-v01.2.3', 'cli-v1.2.3/evil', 'cli-v1.2.3\n']:
            self.assertIsNone(release.TAG.fullmatch(tag))

    def executable(self):
        original = bytearray(512)
        original[:2] = b'MZ'
        struct.pack_into('<I', original, 0x3c, 128)
        original[128:132] = b'PE\0\0'
        struct.pack_into('<H', original, 152, 0x20b)
        signed = bytearray(original) + b'\0' * 16
        struct.pack_into('<I', signed, 216, 12345)  # PE checksum
        struct.pack_into('<II', signed, 296, 512, 16)
        return original, signed

    def test_signing_preserves_executable_content(self):
        original, signed = self.executable()
        release.same_executable(original, signed)
        for index in [0, 80, 220, 400]:
            changed = bytearray(signed)
            changed[index] ^= 1
            with self.subTest(index=index), self.assertRaises((ValueError, struct.error)):
                release.same_executable(original, changed)
        with self.assertRaises(ValueError):
            release.same_executable(original, original)
        with self.assertRaises(ValueError):
            release.same_executable(original, signed + b'extra')

    def test_download_redirect_never_forwards_token_to_storage(self):
        req = Request('https://api.github.com/repos/a/b/actions/artifacts/1/zip', headers={'Authorization': 'Bearer test'})
        target = release.SafeRedirect().redirect_request(req, None, 302, '', {}, 'https://example.com/file.zip')
        self.assertIsNone(target.get_header('Authorization'))
        with self.assertRaises(ValueError):
            release.SafeRedirect().redirect_request(req, None, 302, '', {}, 'http://example.com/file.zip')

    def test_artifact_checks_digest_and_exact_file_list(self):
        class API:
            def request(self, *args, **kwargs):
                return data
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w') as archive:
            archive.writestr('bsk.exe', b'MZ')
            archive.writestr('request.json', '{}')
        data = buf.getvalue()
        artifact = {'id': 1, 'expired': False, 'digest': 'sha256:' + release.digest(data)}
        self.assertEqual(release.unpack_artifact(API(), artifact, ['bsk.exe', 'request.json'])['bsk.exe'], b'MZ')
        for change in [dict(expired=True), dict(digest=None), dict(digest='sha256:' + '0'*64)]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                release.unpack_artifact(API(), {**artifact, **change}, ['bsk.exe', 'request.json'])
        with self.assertRaises(ValueError):
            release.unpack_artifact(API(), artifact, ['bsk.exe'])

    def test_annotated_tag_is_peeled_and_must_be_on_default_branch(self):
        class API:
            def request(self, path):
                if path.startswith('git/ref/'):
                    return {'object': {'type': 'tag', 'sha': 'b'*40}}
                if path.startswith('git/tags/'):
                    return {'object': {'type': 'commit', 'sha': 'a'*40}}
                if path == '':
                    return {'default_branch': 'main'}
                return {'status': status}
        status = 'ahead'
        self.assertEqual(release.tag_commit(API(), 'cli-v1.2.3'), 'a'*40)
        status = 'diverged'
        with self.assertRaises(ValueError):
            release.tag_commit(API(), 'cli-v1.2.3')


if __name__ == '__main__':
    unittest.main()
