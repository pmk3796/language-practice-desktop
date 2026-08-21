'use strict';

const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');

const run = promisify(execFile);

/**
 * Prepare the packed app for distribution: tighten App Transport Security,
 * strip extended attributes, then ad-hoc sign it.
 *
 * App Transport Security: electron-builder writes
 * NSAppTransportSecurity.NSAllowsArbitraryLoads = true into every macOS build
 * (see configureLocalhostAts in app-builder-lib), which switches ATS off for
 * every host. It does that so a plain-HTTP loopback origin works, but it also
 * writes explicit 127.0.0.1 and localhost exceptions alongside — and those are
 * the only insecure origin this app talks to. Everything else it contacts is
 * api.openai.com over TLS. So the blanket flag is removed here and the
 * exceptions are left in place. It cannot be done through mac.extendInfo:
 * electron-builder sets the flag after merging extendInfo, so it would just be
 * overwritten.
 *
 * Extended attributes: codesign refuses any file carrying a resource fork or
 * Finder info ("...or similar detritus not allowed"). The project sources live
 * under ~/Desktop, which iCloud Drive syncs and stamps with
 * com.apple.fileprovider and com.apple.FinderInfo, and the packer copies those
 * files — attributes and all — into the bundle. Builds write outside the synced
 * tree (see directories.output) so nothing re-stamps the output mid-signing,
 * but the copies still arrive dirty, so they are cleared here.
 *
 * Ad-hoc signature: with mac.identity set to null, electron-builder skips
 * signing altogether rather than falling back to an ad-hoc signature. What
 * survives is the linker-signed stub Electron ships, whose seal no longer
 * matches a bundle we have renamed and added files to — Apple Silicon refuses
 * to launch that. Signing with the "-" identity re-seals the bundle as it
 * actually is. It confers no trust: Gatekeeper still requires the user to
 * right-click → Open the first time. Replace this with a real Developer ID
 * signature once the certificate exists.
 *
 * afterPack is the last hook before the DMG is assembled — and the only one
 * that runs at all when signing is skipped, since electron-builder fires
 * afterSign only after a successful sign.
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  // Before signing: any edit to the bundle after codesign invalidates the seal.
  const plist = path.join(app, 'Contents', 'Info.plist');
  // -remove exits non-zero when the key is already absent, which is a fine
  // outcome — only a real failure to write should stop the build.
  await run('plutil', ['-remove', 'NSAppTransportSecurity.NSAllowsArbitraryLoads', plist]).catch(
    () => {},
  );
  const { stdout: ats } = await run('plutil', ['-extract', 'NSAppTransportSecurity', 'json', '-o', '-', plist]);
  if (JSON.parse(ats).NSAllowsArbitraryLoads) {
    throw new Error('NSAllowsArbitraryLoads is still set in Info.plist after the removal step.');
  }

  await run('xattr', ['-cr', app]);
};
