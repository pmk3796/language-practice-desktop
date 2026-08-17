'use strict';

const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');

const run = promisify(execFile);

/**
 * Prepare the packed app for distribution: strip extended attributes, then
 * ad-hoc sign it.
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

  await run('xattr', ['-cr', app]);
  // --deep is deprecated for signing with a real identity, but it remains the
  // supported way to ad-hoc sign nested code (helpers, frameworks) bottom-up.
  await run('codesign', ['--force', '--deep', '--sign', '-', app]);
};
