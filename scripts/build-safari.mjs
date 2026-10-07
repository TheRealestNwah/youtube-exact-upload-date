// Packages the extension for Safari on macOS.
//
//   node scripts/build-safari.mjs          -> dist/safari/extension (web extension files only)
//   node scripts/build-safari.mjs --xcode  -> also converts to an Xcode project, builds the
//                                             app ad-hoc signed and zips it (macOS + Xcode only)
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ICON_SIZES = [16, 32, 48, 64, 96, 128, 256, 512];
export const APP_NAME = "Exact Upload Date for YouTube";
export const BUNDLE_ID = "io.github.therealestnwah.youtube-exact-upload-date";
// storage.session (used by the background date cache) needs Safari 16.4.
export const SAFARI_MIN_VERSION = "16.4";

export function safariManifest(manifest) {
  const result = structuredClone(manifest);
  // Safari needs raster icons and ignores Gecko settings.
  const icons = Object.fromEntries(ICON_SIZES.map(size => [String(size), `icons/icon-${size}.png`]));
  result.icons = icons;
  result.action = { ...result.action, default_icon: { 16: icons[16], 32: icons[32], 48: icons[48], 64: icons[64] } };
  result.browser_specific_settings = { safari: { strict_min_version: SAFARI_MIN_VERSION } };
  return result;
}

function buildExtension(outDir) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(safariManifest(manifest), null, 2)}\n`);
  cpSync(join(root, "src"), join(outDir, "src"), { recursive: true });
  cpSync(join(root, "safari", "icons"), join(outDir, "icons"), { recursive: true });
  return manifest.version;
}

function buildApp(distDir, extensionDir, version) {
  const projectDir = join(distDir, "xcode");
  execFileSync("xcrun", [
    "safari-web-extension-converter", extensionDir,
    "--project-location", projectDir,
    "--app-name", APP_NAME,
    "--bundle-identifier", BUNDLE_ID,
    "--macos-only", "--swift", "--copy-resources",
    "--no-open", "--no-prompt", "--force",
  ], { stdio: "inherit" });

  const appProjectDir = join(projectDir, APP_NAME);
  const xcodeproj = readdirSync(appProjectDir).find(name => name.endsWith(".xcodeproj"));
  // The converter derives the app target's ID from the app name instead of --bundle-identifier,
  // which breaks Xcode's check that the extension's ID is prefixed by the app's.
  const pbxproj = join(appProjectDir, xcodeproj, "project.pbxproj");
  writeFileSync(pbxproj, readFileSync(pbxproj, "utf8").replace(
    /PRODUCT_BUNDLE_IDENTIFIER = (?![^;]*\.Extension)[^;]+;/g,
    `PRODUCT_BUNDLE_IDENTIFIER = "${BUNDLE_ID}";`,
  ));
  const buildDir = join(distDir, "build");
  execFileSync("xcodebuild", [
    "-project", join(appProjectDir, xcodeproj),
    "-alltargets", "-configuration", "Release",
    `SYMROOT=${buildDir}`,
    `MARKETING_VERSION=${version}`,
    // Ad-hoc signature: enough to run locally with "Allow Unsigned Extensions".
    "CODE_SIGN_IDENTITY=-", "CODE_SIGN_STYLE=Manual", "DEVELOPMENT_TEAM=",
    "build",
  ], { stdio: "inherit" });

  const releaseDir = join(buildDir, "Release");
  const app = readdirSync(releaseDir).find(name => name.endsWith(".app"));
  const zip = join(distDir, `youtube-exact-upload-date-safari-${version}.zip`);
  execFileSync("ditto", ["-c", "-k", "--keepParent", join(releaseDir, app), zip], { stdio: "inherit" });
  return zip;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const distDir = join(root, "dist", "safari");
  const extensionDir = join(distDir, "extension");
  const version = buildExtension(extensionDir);
  console.log(`Safari web extension files: ${extensionDir}`);
  if (process.argv.includes("--xcode")) {
    if (process.platform !== "darwin") throw new Error("--xcode needs macOS with Xcode installed.");
    console.log(`Safari app: ${buildApp(distDir, extensionDir, version)}`);
  }
}
