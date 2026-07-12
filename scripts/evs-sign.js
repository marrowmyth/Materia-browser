// VMP-sign the packed app with castlabs EVS so production Widevine (Netflix,
// Spotify, Disney+) plays for end users. Runs after electron-builder packs
// win-unpacked, before the installer is built. Auth uses a valid castlabs_evs
// token (or EVS_ACCOUNT / EVS_PASSWD env vars). Uploads to castlabs, so it can
// take a few minutes. Set SLASH_SKIP_EVS=1 for a quick dev build without it
// (Widevine then will not play for end users).
exports.default = async function (context) {
  if (process.env.SLASH_SKIP_EVS === '1') {
    console.log('[evs] SLASH_SKIP_EVS=1, skipping Widevine VMP signing (dev build)');
    return;
  }
  const { spawnSync } = require('child_process');
  const dir = context.appOutDir;
  const py = process.platform === 'win32' ? 'python' : 'python3';
  console.log('[evs] VMP-signing ' + dir + ' (uploads to castlabs; this can take a few minutes)');
  const r = spawnSync(py, ['-m', 'castlabs_evs.vmp', 'sign-pkg', dir], { stdio: 'inherit' });
  if (r.status !== 0) {
    throw new Error(
      '[evs] VMP signing failed (status ' +
        r.status +
        '). Ensure EVS auth works (python -m castlabs_evs.account reauth, or set EVS_ACCOUNT/EVS_PASSWD). ' +
        'To build without Widevine signing, set SLASH_SKIP_EVS=1.',
    );
  }
  console.log('[evs] VMP signing complete');
};
