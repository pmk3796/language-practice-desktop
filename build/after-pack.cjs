'use strict';

const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');

const run = promisify(execFile);

/**
 * Strip extended attributes from the packed app, just before it is signed.
 *
 * codesign refuses any file carrying a resource fork or Finder info
 * ("...or similar detritus not allowed"). This project lives under ~/Desktop,
 * which iCloud Drive syncs, and iCloud stamps com.apple.fileprovider and
 * com.apple.FinderInfo onto files as they are written — so clearing them before
 * a build does not help: they come back on the copies the build makes.
 *
 * afterPack runs after the bundle is assembled and before signing, which is the
 * only point where clearing them sticks.
 *
 * A no-op on machines that do not have the problem.
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  await run('xattr', ['-cr', app]);
};
